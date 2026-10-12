/** Shared by the read-only host and the trusted browser-review gate. */
export const websiteArtifactOrigin = "https://api.prompix.dev";
export const websiteArtifactByteLimit = 2_000_000;
// An opaque sandbox origin isolates inline demos from the content API and each other.
// Reviewers must still inspect actual behavior; CSP is not an approval mechanism.
export const websiteContentSecurityPolicy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox allow-scripts";
