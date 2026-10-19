import SwiftUI
import ThinkingOrbs

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

extension StatusLine where Mark == SessionStatusMark {
    /// A session's headline beside its `SessionStatusMark`.
    init(session: Session, size: CGFloat = 12, lineLimit: Int = 1) {
        self.init(headline: session.headline, tone: session.tone, size: size, lineLimit: lineLimit, mark: SessionStatusMark(session: session))
    }
}

/// A session headline's mark: the orb while something moves the session, its figure the
/// step at work; otherwise its dot. Either sits in the orb's square, so the headline
/// stays put as the session moves and stops. Board rows and step evidence keep dots.
struct SessionStatusMark: View {
    let session: Session

    var body: some View {
        Group {
            if session.dot == .moving {
                AgentOrb(state: (session.focusedStepKey ?? .unknown).orbState, color: session.tone.color)
            } else {
                SessionDot(session: session, size: 6)
            }
        }
        .frame(width: AgentOrb.side, height: AgentOrb.side)
    }
}

extension Step.Key {
    /// The orb's figure for the work: searching through a diagnosis, composing a fix,
    /// solving a review.
    var orbState: OrbState {
        switch self {
        case .diagnose: .searching
        case .fix: .composing
        case .pr: .weaving
        case .critique: .solving
        case .ci: .working
        case .deploy: .connecting
        case .unknown: .breathing
        }
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
