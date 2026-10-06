import SwiftUI

// MARK: Loading

/// A value fetched from the daemon: the last good value, or why the first fetch failed.
/// A failed refetch keeps the old value on screen rather than replacing it with an error.
struct Loadable<Value> {
    var value: Value?
    var error: String?

    @MainActor
    func reloaded(_ fetch: () async throws -> Value) async -> Loadable {
        do {
            return Loadable(value: try await fetch(), error: nil)
        } catch is CancellationError {
            return self
        } catch let error as URLError where error.code == .cancelled {
            // The view went away mid-request (the island closed): not a failure.
            return self
        } catch {
            return Loadable(value: value, error: value == nil ? error.userMessage : self.error)
        }
    }
}

/// Loads a value from the daemon and keeps it fresh: refetched every minute while on
/// screen. A failed refetch keeps the last value; a different key starts over. The value
/// lives as long as the view, so a tab shown again or the island reopened fetches anew,
/// a local hop: the daemon keeps each board a minute and the last log sweep in its store.
struct PollingLoader<Value, Content: View>: View {
    let key: String
    let fetch: () async throws -> Value
    @ViewBuilder let content: (Loadable<Value>) -> Content

    @ViewState private var loaded = Loadable<Value>()
    @ViewState private var loadedKey: String?

    var body: some View {
        content(loaded)
            .task(id: key) {
                if loadedKey != key {
                    loaded = Loadable()
                    loadedKey = key
                }
                while !Task.isCancelled {
                    let next = await loaded.reloaded(fetch)
                    // Switching tabs cancels this task after the next one has reset the value:
                    // writing now would put this key's value (or error) under the other tab.
                    guard !Task.isCancelled else { return }
                    loaded = next
                    try? await Task.sleep(for: .seconds(60))
                }
            }
    }
}
