"""Exercise the real AppKit quit loop from a Swift task, in a separate process."""

import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parent.parent
HARNESS = r'''
import AppKit

@MainActor
final class Delegate: NSObject, NSApplicationDelegate {
    let termination = AppTermination()
    var stops = 0
    let delayed = CommandLine.arguments.contains("delayed")

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.prohibited)
        Task {
            NSApp.terminate(nil)
            if delayed {
                // Another quit while shutdown is pending must not start it again.
                NSApp.terminate(nil)
            }
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        termination.reply(to: sender) { done in
            guard delayed else { return false }
            stops += 1
            Task {
                try? await Task.sleep(for: .milliseconds(100))
                done()
            }
            return true
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        print("shutdown finished; stops=\(stops)")
    }
}

@main
struct Harness {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = Delegate()
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
'''


class AppTerminationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="bt-termination-")
        cls.addClassCleanup(cls.temp.cleanup)
        root = Path(cls.temp.name)
        source = root / "Harness.swift"
        source.write_text(HARNESS)
        cls.binary = root / "Harness"
        subprocess.run(
            ["swiftc", "-swift-version", "6", "-parse-as-library",
             str(ROOT / "app/Sources/Bridgetown/AppTermination.swift"),
             str(source), "-o", str(cls.binary)],
            check=True, capture_output=True, text=True, timeout=60,
        )

    def test_quit_from_a_task_waits_for_shutdown_without_blocking_tasks(self):
        result = subprocess.run(
            [str(self.binary), "delayed"], capture_output=True, text=True, timeout=5,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("shutdown finished; stops=1", result.stdout)

    def test_quit_without_a_daemon_ends_immediately(self):
        result = subprocess.run(
            [str(self.binary)], capture_output=True, text=True, timeout=5,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("shutdown finished; stops=0", result.stdout)

    def test_app_delegate_quits_and_stops_its_real_child(self):
        binary = ROOT / "app/.build/debug/Bridgetown"
        if not binary.exists():
            self.skipTest("Run make test-app to build Bridgetown first")
        with tempfile.TemporaryDirectory(prefix="bt-quit-smoke-") as folder:
            root = Path(folder)
            env = dict(os.environ, BRIDGETOWN_DAEMON_CMD="/bin/sleep 60",
                       BRIDGETOWN_PORT="47622", BRIDGETOWN_LOG_DIR=folder)
            app = subprocess.Popen(
                [str(binary), "--e2e", "none", "--e2e-out", str(root / "run")],
                env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            children = []
            try:
                for _ in range(100):
                    result = subprocess.run(
                        ["pgrep", "-P", str(app.pid)], capture_output=True, text=True,
                    )
                    children = [int(pid) for pid in result.stdout.split()]
                    if children:
                        break
                    time.sleep(0.02)
                self.assertTrue(children, "App did not launch its daemon child")
                app.send_signal(signal.SIGTERM)
                _, errors = app.communicate(timeout=5)
                self.assertEqual(app.returncode, 0, errors)
                for pid in children:
                    with self.assertRaises(ProcessLookupError):
                        os.kill(pid, 0)
            finally:
                if app.poll() is None:
                    app.kill()
                    app.wait()
                for pid in children:
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass


if __name__ == "__main__":
    unittest.main()
