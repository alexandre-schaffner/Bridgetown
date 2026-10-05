# README visuals

The two MacBook mockups use real app captures from the local mock daemon. The device frames and studio background were generated around those captures. All displayed incidents, messages, pull requests, and production signals are demo fixtures.

To refresh the source captures, install the daemon dependencies, then run from the repository root:

```sh
bash scripts/readme-screenshots.sh
```

The script builds the debug app, starts a separate mock daemon, captures the overview and `s_mock_merge` session, and stops that daemon. It writes to `.context/readme/` and disables Keychain access through the app’s snapshot harness. Set `BRIDGETOWN_SCREENSHOT_PORT` if the default port, `47653`, is occupied.

Use the captures as inserts for matching front-facing MacBook mockups. Bridgetown expands from the notch itself: its black surface reaches the display’s top edge and incorporates the physical notch. It is not a separate floating window or menu bar app. Keep the macOS desktop visible on both sides and below it, and use the real 480-point open height. Never stretch the capture to fill the display. Keep the interface, labels, values, and proportions intact. Save the finished assets as `bridgetown-overview.png` and `bridgetown-session.png` here, then inspect them at README width for legibility.
