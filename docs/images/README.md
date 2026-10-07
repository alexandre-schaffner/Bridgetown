# README screenshots

These are unmodified captures of the running SwiftUI app using local demo data. All displayed incidents, messages, pull requests, and production signals are demo fixtures.

To refresh them, install the daemon dependencies, then run from the repository root:

```sh
bash scripts/readme-screenshots.sh
cp .context/readme/overview.png docs/images/bridgetown-overview.png
cp .context/readme/session.png docs/images/bridgetown-session.png
```

The script runs the debug app through the e2e harness (`scripts/e2e.sh`), which starts its own static mock daemon on a free port, and captures the overview and `s_mock_merge` session at the real 480-point open height. It writes to `.context/readme/`; the harness keeps the Keychain in memory and draws off screen. The capture also becomes `.context/e2e/latest`, so pass `BASELINE=.context/e2e/<a full run>` to the next `make e2e` to diff against a complete run.

Publish the native captures directly. Do not regenerate the interface or add a device frame.
