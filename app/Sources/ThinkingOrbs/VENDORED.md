# ThinkingOrbs

Libraries.dev's thinking orbs (https://libraries.dev/orbs), the SwiftUI port (`ThinkingOrbsKit`), as of upstream
commit `bfcb863`. MIT, see `LICENSE`.

What differs from upstream:

- The snapshot helper (`snapshot.sh` and its harness) is left out. `orbFrozenTime` stays, as upstream has it.
- `ThinkingOrb` takes a `tint`, which multiplies the ink so the lightest dots take that colour. It needs
  `Color.resolve(in:)`, so the view is available from macOS 14 / iOS 17 rather than 12 / 15.
- The animation is capped at 60 fps (`TimelineView(.animation(minimumInterval:))`).

To update: copy upstream's Swift sources over this directory, keep `LICENSE` and this file, and reapply
the changes above.
