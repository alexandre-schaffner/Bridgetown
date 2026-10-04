import SwiftUI

/// Dot plus the daemon's headline, coloured by `tone`. The dot carries the colour; the
/// words carry the meaning, so the line reads the same without colour.
struct StatusLine: View {
    let headline: String
    let tone: Tone
    var size: CGFloat = 12
    /// A finished session's headline carries its resolution ("Failed · Could not start: …"), so it may wrap.
    var lineLimit = 1

    init(headline: String, tone: Tone, size: CGFloat = 12, lineLimit: Int = 1) {
        self.headline = headline
        self.tone = tone
        self.size = size
        self.lineLimit = lineLimit
    }

    init(session: Session, size: CGFloat = 12, lineLimit: Int = 1) {
        self.init(headline: session.headline, tone: session.tone, size: size, lineLimit: lineLimit)
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            LiveDot(color: tone.color, live: tone == .live)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + size * 0.35 }
            Text(headline)
                .font(.geist(size, .medium))
                .foregroundStyle(tone.isQuiet ? .secondary : .primary)
                .lineLimit(lineLimit)
                .truncationMode(.tail)
                .fixedSize(horizontal: false, vertical: lineLimit > 1)
        }
        .accessibilityElement(children: .combine)
    }
}
