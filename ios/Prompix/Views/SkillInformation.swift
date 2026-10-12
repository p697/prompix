import SwiftUI

struct SkillInformation: View {
    let skill: Prompt.Skill
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label(String(localized: "使用这个 Skill"), systemImage: "square.stack.3d.up").font(.headline)
            Text(String(localized: "在支持 Agent Skills 的编程助手中使用。请从来源页面获取完整文件夹，单独复制说明可能缺少脚本或参考文件。"))
                .font(.subheadline).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            Link(destination: skill.installURL) {
                HStack {
                    Text(String(localized: "查看源文件与安装说明")).font(.subheadline.weight(.medium))
                    Spacer(minLength: 8)
                    Image(systemName: "arrow.up.right")
                }.frame(minHeight: 44)
            }.accessibilityIdentifier("skillSource")
            if let files = skill.files, !files.isEmpty {
                DisclosureGroup(String(localized: "包含 \(files.count) 个文件")) {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(files, id: \.self) { path in
                            Text(path).font(.footnote.monospaced()).textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }.padding(.top, 12)
                }.font(.subheadline).accessibilityIdentifier("skillFiles")
            }
        }.padding(20).background(Palette.soft, in: RoundedRectangle(cornerRadius: 18))
    }
}
