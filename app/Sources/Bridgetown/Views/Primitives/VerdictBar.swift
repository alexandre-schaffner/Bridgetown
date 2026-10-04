import SwiftUI

/// One probability as a labelled bar: "Actionable ▬▬▬── 72%".
struct VerdictBar: View {
    let label: String
    let value: Double
    let tint: Color

    var body: some View {
        HStack(spacing: 10) {
            Text(label)
                .font(.geist(12.5))
                .foregroundStyle(.secondary)
                .frame(width: 124, alignment: .leading)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 1, style: .continuous).fill(Ink.track)
                    RoundedRectangle(cornerRadius: 1, style: .continuous).fill(tint)
                        .frame(width: max(2, geo.size.width * min(max(value, 0), 1)))
                }
            }
            .frame(height: 6)
            Text(Format.percent(value))
                .font(.geist(12.5, .medium).monospacedDigit())
                .foregroundStyle(.primary)
                .frame(width: 42, alignment: .trailing)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label) \(Format.percent(value))")
    }
}
