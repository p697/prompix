import SwiftUI

struct PromptVariablesSheet: View {
    let template: PromptTemplate
    let onApply: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focusedField: String?
    @State private var values: [String: String]

    init(template: PromptTemplate, onApply: @escaping (String) -> Void) {
        self.template = template; self.onApply = onApply
        _values = State(initialValue: Dictionary(uniqueKeysWithValues: template.fields.map { ($0.id, $0.defaultValue) }))
    }
    private var prepared: String { template.filling(values) }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(String(localized: "按需填写，留空的变量会保留。"))
                        .font(.subheadline).foregroundStyle(Palette.muted)
                }.listRowBackground(Palette.surface)
                Section {
                    ForEach(Array(template.fields.enumerated()), id: \.element.id) { index, field in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(verbatim: field.label).font(.subheadline.weight(.medium))
                            Text(verbatim: field.context).font(.caption).foregroundStyle(Palette.muted)
                                .lineLimit(3).fixedSize(horizontal: false, vertical: true)
                            TextField(String(localized: "填写内容"), text: Binding(get: { values[field.id] ?? "" }, set: { values[field.id] = $0 }), axis: .vertical)
                                .lineLimit(1...5).frame(minHeight: 44).autocorrectionDisabled()
                                .focused($focusedField, equals: field.id)
                                .accessibilityLabel(field.label).accessibilityIdentifier("promptVariable-\(index)")
                        }.padding(.vertical, 4)
                    }
                }.listRowBackground(Palette.surface)
                Section {
                    DisclosureGroup(String(localized: "查看完整内容")) {
                        Text(prepared).font(.footnote).textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("preparedPromptPreview")
                    }.accessibilityIdentifier("variablePreview")
                }.listRowBackground(Palette.surface)
            }
            .accessibilityIdentifier("promptVariablesForm")
            .scrollDismissesKeyboard(.interactively)
            .scrollContentBackground(.hidden).background(Palette.paper)
            .navigationTitle(String(localized: "填写变量")).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(String(localized: "取消")) { dismiss() }.accessibilityIdentifier("cancelPromptVariables") }
                ToolbarItem(placement: .confirmationAction) {
                    if focusedField != nil {
                        Button(String(localized: "完成")) { focusedField = nil }.accessibilityIdentifier("dismissVariableKeyboard")
                    }
                }
            }
            .promptActionBar {
                Button { onApply(prepared); dismiss() } label: {
                    PrimaryActionLabel(title: String(localized: "应用并继续"), compactTitle: String(localized: "应用"), symbol: "checkmark")
                }.buttonStyle(.plain).padding(20).background(Palette.paper)
                    .disabled(prepared == template.source).opacity(prepared == template.source ? 0.45 : 1)
                    .accessibilityIdentifier("applyPromptVariables")
            }
        }.promptSheet()
    }
}
