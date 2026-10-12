import Foundation
import Darwin

/// Raw bytes and derived models share one verified release identity. A partial
/// edition contains complete packs for only the explicitly provided locales.
struct LanguagePackEdition: Sendable {
    let manifestBytes: Data
    let baseBytes: Data
    let localeBytes: [String: Data]
    let manifest: LanguagePackCatalog.Manifest
    let base: LanguagePackCatalog.Base
    let catalog: Catalog

    init(manifestBytes: Data, baseBytes: Data, localeBytes: [String: Data] = [:]) throws {
        let manifest = try LanguagePackCatalog.verifyManifest(manifestBytes)
        let base = try LanguagePackCatalog.verifyBase(baseBytes, manifest: manifest)
        let catalog = try LanguagePackCatalog.assemble(base: base, localeBytes: localeBytes)
        self.manifestBytes = manifestBytes; self.baseBytes = baseBytes; self.localeBytes = localeBytes
        self.manifest = manifest; self.base = base; self.catalog = catalog
    }
}

/// Stages immutable artifacts only. Library owns committing the active index
/// together with catalog and personal-store migrations in its rollback journal.
struct LanguagePackCache: Sendable {
    static let indexFileName = "language-packs.json"
    static let indexByteLimit = 64_000
    private static let artifactDirectoryName = "v2-artifacts"

    enum CacheError: Error { case invalidIndex, unsafeFile, tooLarge, readbackMismatch }

    struct Index: Codable, Sendable {
        let schemaVersion = 1
        let manifestBytes: Data
        let downloadedLocales: [String: String]
        let manifest: LanguagePackCatalog.Manifest

        init(manifestBytes: Data, downloadedLocales: [String: String]) throws {
            let manifest = try LanguagePackCatalog.verifyManifest(manifestBytes)
            guard downloadedLocales.count <= LanguagePackCatalog.supportedLocales.count,
                  downloadedLocales.allSatisfy({ manifest.locales[$0.key]?.sha256 == $0.value }) else {
                throw CacheError.invalidIndex
            }
            self.manifestBytes = manifestBytes; self.downloadedLocales = downloadedLocales; self.manifest = manifest
        }

        private struct Key: CodingKey {
            let stringValue: String
            var intValue: Int? { nil }
            init(stringValue: String) { self.stringValue = stringValue }
            init?(intValue: Int) { return nil }
            static let schemaVersion = Key(stringValue: "schemaVersion")
            static let manifestBytes = Key(stringValue: "manifestBytes")
            static let downloadedLocales = Key(stringValue: "downloadedLocales")
        }

        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: Key.self)
            guard Set(values.allKeys.map(\.stringValue)) == ["schemaVersion", "manifestBytes", "downloadedLocales"],
                  try values.decode(Int.self, forKey: .schemaVersion) == 1 else { throw CacheError.invalidIndex }
            try self.init(manifestBytes: values.decode(Data.self, forKey: .manifestBytes),
                          downloadedLocales: values.decode([String: String].self, forKey: .downloadedLocales))
        }

        func encode(to encoder: Encoder) throws {
            var values = encoder.container(keyedBy: Key.self)
            try values.encode(schemaVersion, forKey: .schemaVersion)
            try values.encode(manifestBytes, forKey: .manifestBytes)
            try values.encode(downloadedLocales, forKey: .downloadedLocales)
        }
    }

    struct Staged: Sendable {
        let index: Index
        let indexData: Data
        fileprivate let lease: ArtifactLease

        /// Keep the staged files pinned through Library's commit or rejection.
        /// Copies share one lease; repeated release is harmless.
        func releaseArtifacts() { lease.release() }
    }

    fileprivate final class ArtifactLease: Sendable {
        let directory: String
        let id: UUID

        init(directory: String, id: UUID) { self.directory = directory; self.id = id }
        func release() { ArtifactPins.shared.release(directory: directory, id: id) }
        deinit { release() }
    }

    /// All cache values for a directory share pins, including background stages
    /// that outlive a cancelled request or a particular Library instance.
    private final class ArtifactPins: @unchecked Sendable {
        static let shared = ArtifactPins()
        private let lock = NSLock()
        private var leases: [String: [UUID: Set<String>]] = [:]

        func reserve(directory: String, hashes: Set<String>) -> ArtifactLease {
            lock.lock(); defer { lock.unlock() }
            let id = UUID()
            leases[directory, default: [:]][id] = hashes
            return ArtifactLease(directory: directory, id: id)
        }

        func release(directory: String, id: UUID) {
            lock.lock(); defer { lock.unlock() }
            leases[directory]?[id] = nil
            if leases[directory]?.isEmpty == true { leases[directory] = nil }
        }

        func withPins<T>(directory: String, _ body: (Set<String>) throws -> T) rethrows -> T {
            lock.lock(); defer { lock.unlock() }
            let hashes = (leases[directory] ?? [:]).values.reduce(into: Set<String>()) { $0.formUnion($1) }
            return try body(hashes)
        }
    }

    private let directory: URL
    private let artifactPinKey: String
    private let artifactWriter: @Sendable (Data, URL) throws -> Void

    init(directory: URL, artifactWriter: @escaping @Sendable (Data, URL) throws -> Void = { try $0.write(to: $1, options: .atomic) }) {
        self.directory = directory.standardizedFileURL
        // Ancestor aliases (including /var versus /private/var) share pins. Keep
        // the original URL for all filesystem safety checks and actual access.
        artifactPinKey = directory.standardizedFileURL.resolvingSymlinksInPath().path
        self.artifactWriter = artifactWriter
    }

    /// An absent active index is a normal v1 installation. A present invalid
    /// index is reported, so callers cannot silently replace it with defaults.
    func readIndex() throws -> Index? {
        guard try existingDirectory(directory) else { return nil }
        let url = directory.appendingPathComponent(Self.indexFileName)
        guard try fileType(at: url) != nil else { return nil }
        let bytes = try boundedRead(url, maximum: Self.indexByteLimit)
        guard !bytes.contains(0), String(data: bytes, encoding: .utf8) != nil else { throw CacheError.invalidIndex }
        return try JSONDecoder().decode(Index.self, from: bytes)
    }

    /// Cache misses, corrupt bytes and unsafe files are never trusted or deleted.
    /// A caller may fetch the descriptor again; staging rejects unsafe targets.
    func readBase(manifest: LanguagePackCatalog.Manifest) -> Data? {
        guard let bytes = try? readArtifact(manifest.base),
              (try? LanguagePackCatalog.verifyBase(bytes, manifest: manifest)) != nil else { return nil }
        return bytes
    }

    func readLocale(_ locale: String, base: LanguagePackCatalog.Base) -> Data? {
        guard let descriptor = base.manifest.locales[locale], let bytes = try? readArtifact(descriptor),
              (try? LanguagePackCatalog.verifyLocale(bytes, locale: locale, base: base)) != nil else { return nil }
        return bytes
    }

    /// Loads precisely the chosen active locales, without eagerly decoding other
    /// recorded packs. Missing selected bytes return nil rather than a partial result.
    func load(_ index: Index, locales: Set<String>) -> LanguagePackEdition? {
        guard locales.isSubset(of: Set(index.downloadedLocales.keys)),
              let bytes = readBase(manifest: index.manifest),
              let base = try? LanguagePackCatalog.verifyBase(bytes, manifest: index.manifest) else { return nil }
        var packs: [String: Data] = [:]
        for locale in locales {
            guard let bytes = readLocale(locale, base: base) else { return nil }
            packs[locale] = bytes
        }
        return try? LanguagePackEdition(manifestBytes: index.manifestBytes, baseBytes: bytes, localeBytes: packs)
    }

    /// Returns bytes for Library's transaction; never writes the active index.
    /// A failed stage can leave only inactive artifacts, safe to verify and reuse.
    func stage(_ edition: LanguagePackEdition, retainingIndex: Index? = nil) throws -> Staged {
        var pinned = Set(edition.localeBytes.keys.compactMap { edition.manifest.locales[$0]?.sha256 })
        pinned.insert(edition.manifest.base.sha256)
        if let previous = retainingIndex, sameDescriptor(previous.manifest.base, edition.manifest.base) {
            for locale in previous.downloadedLocales.keys {
                if let old = previous.manifest.locales[locale], let current = edition.manifest.locales[locale],
                   sameDescriptor(old, current) { pinned.insert(current.sha256) }
            }
        }
        let lease = ArtifactPins.shared.reserve(directory: artifactPinKey, hashes: pinned)
        var completed = false
        defer { if !completed { lease.release() } }
        try createDirectory(directory)
        try createDirectory(artifactDirectory)
        try store(edition.baseBytes, descriptor: edition.manifest.base) {
            _ = try LanguagePackCatalog.verifyBase($0, manifest: edition.manifest)
        }
        var downloaded: [String: String] = [:]
        if let previous = retainingIndex, sameDescriptor(previous.manifest.base, edition.manifest.base) {
            for locale in previous.downloadedLocales.keys {
                guard let old = previous.manifest.locales[locale], let current = edition.manifest.locales[locale],
                      sameDescriptor(old, current), readLocale(locale, base: edition.base) != nil else { continue }
                downloaded[locale] = current.sha256
            }
        }
        for locale in LanguagePackCatalog.supportedLocales {
            guard let bytes = edition.localeBytes[locale], let descriptor = edition.manifest.locales[locale] else { continue }
            try store(bytes, descriptor: descriptor) { _ = try LanguagePackCatalog.verifyLocale($0, locale: locale, base: edition.base) }
            downloaded[locale] = descriptor.sha256
        }
        let index = try Index(manifestBytes: edition.manifestBytes, downloadedLocales: downloaded)
        let bytes = try JSONEncoder().encode(index)
        guard bytes.count <= Self.indexByteLimit else { throw CacheError.tooLarge }
        completed = true
        return Staged(index: index, indexData: bytes, lease: lease)
    }

    /// Library calls this after commit or stage settlement. MainActor serializes
    /// it with every Library transaction/recovery; the pin lock prevents a new
    /// background stage from starting between the keep-set snapshot and deletion.
    /// Cleanup never changes the outcome of a successful catalog transaction.
    @MainActor func pruneInactiveArtifacts() {
        try? ArtifactPins.shared.withPins(directory: artifactPinKey) { pinned in
            guard try existingDirectory(directory), try existingDirectory(artifactDirectory),
                  try fileType(at: directory.appendingPathComponent("catalog-transaction.json")) == nil,
                  let active = try readIndex() else { return }
            var keep = pinned
            keep.insert(active.manifest.base.sha256)
            keep.formUnion(active.downloadedLocales.values)
            try removeInactiveArtifacts(keeping: keep)
        }
    }

    private func removeInactiveArtifacts(keeping hashes: Set<String>) throws {
        let root = open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard root >= 0 else { throw CacheError.unsafeFile }
        defer { close(root) }
        let artifacts = openat(root, Self.artifactDirectoryName, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard artifacts >= 0 else { throw CacheError.unsafeFile }
        guard let entries = fdopendir(artifacts) else { close(artifacts); throw CacheError.unsafeFile }
        defer { closedir(entries) }
        while let entry = readdir(entries) {
            let name = withUnsafePointer(to: entry.pointee.d_name) { pointer in
                pointer.withMemoryRebound(to: CChar.self, capacity: Int(entry.pointee.d_namlen) + 1) { String(cString: $0) }
            }
            guard name.utf8.count == 69, name.hasSuffix(".json") else { continue }
            let hash = String(name.prefix(64))
            guard hash.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }), !hashes.contains(hash) else { continue }
            var status = stat()
            guard fstatat(artifacts, name, &status, AT_SYMLINK_NOFOLLOW) == 0,
                  status.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG) else { continue }
            // unlinkat never recurses into a directory or follows a final symlink.
            // An individual failure is harmless; a later sweep can retry.
            _ = unlinkat(artifacts, name, 0)
        }
    }

    private var artifactDirectory: URL { directory.appendingPathComponent(Self.artifactDirectoryName, isDirectory: true) }

    private func artifactURL(_ descriptor: LanguagePackCatalog.Descriptor) -> URL {
        // Only the codec can create descriptors, with an exact lowercase SHA-256.
        artifactDirectory.appendingPathComponent(descriptor.sha256 + ".json")
    }

    private func sameDescriptor(_ first: LanguagePackCatalog.Descriptor, _ second: LanguagePackCatalog.Descriptor) -> Bool {
        first.sha256 == second.sha256 && first.byteCount == second.byteCount && first.count == second.count && first.url == second.url
    }

    private func readArtifact(_ descriptor: LanguagePackCatalog.Descriptor) throws -> Data {
        guard try existingDirectory(directory), try existingDirectory(artifactDirectory) else { throw CocoaError(.fileNoSuchFile) }
        return try boundedRead(artifactURL(descriptor), maximum: descriptor.byteCount)
    }

    private func store(_ bytes: Data, descriptor: LanguagePackCatalog.Descriptor, verify: (Data) throws -> Void) throws {
        try verify(bytes)
        let url = artifactURL(descriptor)
        if let type = try fileType(at: url) {
            guard type == mode_t(S_IFREG) else { throw CacheError.unsafeFile }
            if let existing = try? readArtifact(descriptor), existing == bytes { return }
            // Valid identities are immutable. An invalid regular cache file can
            // be repaired with independently verified bytes after a fresh fetch.
        }
        try artifactWriter(bytes, url)
        let stored = try readArtifact(descriptor)
        guard stored == bytes else { throw CacheError.readbackMismatch }
        try verify(stored)
    }

    private func createDirectory(_ url: URL) throws {
        guard url.isFileURL else { throw CacheError.unsafeFile }
        if let type = try fileType(at: url) {
            guard type == mode_t(S_IFDIR) else { throw CacheError.unsafeFile }
        } else {
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            guard try existingDirectory(url) else { throw CacheError.unsafeFile }
        }
    }

    private func existingDirectory(_ url: URL) throws -> Bool {
        guard url.isFileURL else { throw CacheError.unsafeFile }
        guard let type = try fileType(at: url) else { return false }
        guard type == mode_t(S_IFDIR) else { throw CacheError.unsafeFile }
        return true
    }

    private func fileType(at url: URL) throws -> mode_t? {
        var status = stat()
        guard lstat(url.path, &status) == 0 else {
            if errno == ENOENT { return nil }
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        return status.st_mode & mode_t(S_IFMT)
    }

    private func boundedRead(_ url: URL, maximum: Int) throws -> Data {
        // O_NOFOLLOW rejects final symlinks and O_NONBLOCK avoids blocking on a
        // FIFO before fstat rejects it. No artifact read can exceed its descriptor.
        let descriptor = open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        var status = stat()
        guard fstat(descriptor, &status) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        guard status.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG) else { throw CacheError.unsafeFile }
        guard status.st_size >= 0, status.st_size <= off_t(maximum) else { throw CacheError.tooLarge }
        var bytes = Data()
        while bytes.count <= maximum {
            guard let chunk = try handle.read(upToCount: min(64_000, maximum + 1 - bytes.count)), !chunk.isEmpty else { break }
            bytes.append(chunk)
        }
        guard bytes.count <= maximum else { throw CacheError.tooLarge }
        return bytes
    }
}
