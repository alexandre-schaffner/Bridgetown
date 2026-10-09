# README screenshots

These are unmodified captures of the running SwiftUI app using local demo data. All displayed incidents, messages, pull requests, and production signals are demo fixtures.

To refresh them, install the daemon dependencies, then run from the repository root:

```sh
scripts/showcase-screenshots.sh
```

The script runs the debug app through the e2e harness (`scripts/e2e.sh`) on the screens in `app/E2E/showcase.json`, which starts its own static mock daemon on a free port, keeps the Keychain in memory and draws off screen. It copies the overview and the `s_mock_merge` session, at the real 480-point open height, here, and every screen into `site/src/assets/app/` for the landing page and the launch film. The capture also becomes `.context/e2e/latest`, so pass `BASELINE=.context/e2e/<a full run>` to the next `make e2e` to diff against a complete run.

Publish the native captures directly. Do not regenerate the interface or add a device frame.
