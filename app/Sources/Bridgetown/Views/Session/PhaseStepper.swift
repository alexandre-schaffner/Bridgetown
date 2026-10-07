import SwiftUI

/// The step counter is the disclosure: compact at rest, evidence available inline.
struct PhaseStepper: View {
    let session: Session
    @ViewState private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(reduceMotion ? nil : Easing.state) { expanded.toggle() }
            } label: {
                StepCounter(session: session, expanded: expanded)
                    .frame(minHeight: Ink.buttonHeight)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .hoverFill(radius: Ink.controlRadius)
            .accessibilityLabel(expanded ? "Hide step details" : "Show step details")
            .accessibilityValue(session.focusedStepDescription)
            .accessibilityIdentifier("session.steps.toggle")
            .help(expanded ? "Hide step details" : "Show step details")

            if expanded {
                VStack(spacing: 0) {
                    Hairline()
                    ForEach(Array(session.steps.indices), id: \.self) { index in
                        StepEvidenceRow(session: session, index: index)
                        if index < session.steps.count - 1 { Hairline() }
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("session.steps.details")
                .transition(.opacity)
            }
        }
        .onChange(of: session.id) { _, _ in expanded = false }
    }
}

/// Board rows open the session; its detail owns the step disclosure.
struct StepTrack: View {
    let session: Session

    var body: some View {
        HStack {
            StepCounter(session: session)
            Spacer(minLength: 0)
        }
        .frame(minHeight: 18)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(session.stepsDescription)
    }
}

private struct StepCounter: View {
    let session: Session
    var expanded: Bool?

    var body: some View {
        HStack(spacing: 10) {
            if let index = session.focusedStepIndex {
                (Text("\(index + 1)").foregroundStyle(.secondary)
                 + Text(" / \(session.steps.count)").foregroundStyle(.tertiary))
                    .font(.geistMono(11))
                    .fixedSize()
                HStack(spacing: 6) {
                    if session.stepKind(at: index) == .moving {
                        Spinner(color: session.stepTint(at: index), lineWidth: 1.25)
                            .frame(width: 9, height: 9)
                            .accessibilityHidden(true)
                    }
                    Text(session.steps[index].label)
                        .font(Typo.label)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                }
            } else {
                Text("Steps").font(Typo.label).foregroundStyle(.secondary)
            }
            if let expanded {
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(expanded ? 90 : 0))
            }
        }
    }
}

private struct StepEvidenceRow: View {
    let session: Session
    let index: Int

    private var step: Step { session.steps[index] }
    private var kind: Session.StepKind { session.stepKind(at: index) }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            mark
                .frame(width: 12, height: 12)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    heading
                    evidence
                }
                .fixedSize(horizontal: true, vertical: false)
                VStack(alignment: .leading, spacing: 4) {
                    heading
                    evidence
                }
                .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 9)
        .accessibilityElement(children: .combine)
    }

    private var heading: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(step.label)
                .font(Typo.label)
                .foregroundStyle(kind.isMarked ? Ink.text : Ink.dim)
            Text(session.stepStatus(at: index))
                .font(Typo.caption)
                .foregroundStyle(Ink.faint)
        }
    }

    @ViewBuilder
    private var evidence: some View {
        if let detail = step.detail {
            Text(detail)
                .font(Typo.small)
                .foregroundStyle(Ink.dim)
        }
    }

    @ViewBuilder
    private var mark: some View {
        let tint = session.stepTint(at: index)
        switch kind {
        case .moving: Spinner(color: tint)
        case .you: Beacon(color: tint, breathes: true)
        case .ahead, .held:
            Circle().strokeBorder(kind == .held ? tint : Ink.faint, lineWidth: 1)
                .frame(width: 7, height: 7)
        case .failed:
            Image(systemName: "xmark").font(.system(size: 9, weight: .semibold)).foregroundStyle(tint)
        case .stopped, .skipped:
            Image(systemName: "minus").font(.system(size: 9, weight: .medium)).foregroundStyle(.tertiary)
        case .done, .resolved:
            Image(systemName: "checkmark").font(.system(size: 9, weight: .medium)).foregroundStyle(tint)
        }
    }
}
