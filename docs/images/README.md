# README screenshots

These are unmodified captures of the running SwiftUI app using local demo data. All displayed incidents, messages, pull requests, and production signals are demo fixtures.

To refresh them, install the daemon dependencies, then run from the repository root:

```sh
bash scripts/readme-screenshots.sh
cp .context/readme/overview.png docs/images/bridgetown-overview.png
cp .context/readme/session.png docs/images/bridgetown-session.png
```

The script builds the debug app, starts a separate mock daemon, captures the overview and `s_mock_merge` session at the real 480-point open height, and stops that daemon. It writes to `.context/readme/` and disables Keychain access through the app’s snapshot harness. Set `BRIDGETOWN_SCREENSHOT_PORT` if the default port, `47653`, is occupied.

Publish the native captures directly. Do not regenerate the interface or add a device frame.
