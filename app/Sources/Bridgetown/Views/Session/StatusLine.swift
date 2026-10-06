import SwiftUI

/// A mark plus the daemon's headline, its status word in `tone`'s colour. The words carry
/// the meaning, so the line reads the same without colour.
struct StatusLine<Mark: View>: View {
    let headline: String
    let tone: Tone
    var size: CGFloat
    /// A finished session's headline carries its resolution ("Failed · Could not start: …"), so it may wrap.
    var lineLimit: Int
    let mark: Mark

    var body: some View {
        // The mark's middle, level with the middle of the headline's capitals.
        let lift = size * 0.35
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            mark
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + lift }
            tone.headline(headline)
                .font(.geist(size, .medium))
                .foregroundStyle(tone.isQuiet ? .secondary : .primary)
                .lineLimit(lineLimit)
                .truncationMode(.tail)
                .fixedSize(horizontal: false, vertical: lineLimit > 1)
        }
        .accessibilityElement(children: .combine)
    }
}

extension StatusLine where Mark == LiveDot {
    /// An outcome with no session behind it: a dot in its tone, breathing while live.
    init(headline: String, tone: Tone, size: CGFloat = 12, lineLimit: Int = 1) {
        self.init(headline: headline, tone: tone, size: size, lineLimit: lineLimit, mark: LiveDot(color: tone.color, live: tone == .live))
    }
}

extension StatusLine where Mark == SessionDot {
    /// A session's headline beside the dot its row has on the Agents board.
    init(session: Session, size: CGFloat = 12, lineLimit: Int = 1) {
        self.init(headline: session.headline, tone: session.tone, size: size, lineLimit: lineLimit, mark: SessionDot(session: session, size: 6))
    }
}

/// A session's dot (`Session.Dot`): pulsing while something moves it, a ring while it
/// waits on reviewers or the queue, filled and still when it is on you or has ended.
struct SessionDot: View {
    let session: Session
    var size: CGFloat = 7

    var body: some View {
        Group {
            switch session.dot {
            case .moving: LiveDot(color: session.tone.color, live: true, size: size)
            case .still: LiveDot(color: session.tone.color, size: size)
            case .waiting: Circle().strokeBorder(Color.secondary, lineWidth: 1.5)
            }
        }
        .frame(width: size, height: size)
        .help(session.holder.map { "\($0.label.prefix(1).uppercased())\($0.label.dropFirst())" } ?? "")
    }
}
