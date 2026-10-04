import SwiftUI

/// One probability as a labelled bar: "Actionable ▬▬▬── 72%".
struct VerdictBar: View {
    let label: String
    let value: Double
    let tint: Color

    var body: some View {
        HStack(spacing: 10) {
            Text(label)
                .font(.geist(11))
                .foregroundStyle(.secondary)
                .frame(width: 104, alignment: .leading)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Ink.track)
                    Capsule().fill(tint)
                        .frame(width: max(5, geo.size.width * min(max(value, 0), 1)))
                }
            }
            .frame(height: 5)
            Text(Format.percent(value))
                .font(.geist(11, .medium).monospacedDigit())
                .foregroundStyle(.primary)
                .frame(width: 36, alignment: .trailing)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label) \(Format.percent(value))")
    }
}
