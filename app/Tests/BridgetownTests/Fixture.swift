import Foundation
@testable import Bridgetown

/// JSON in Fixtures/, written to match docs/API.md field for field.
enum Fixture {
    static func data(_ name: String) throws -> Data {
        guard let url = Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures") else {
            throw CocoaError(.fileNoSuchFile)
        }
        return try Data(contentsOf: url)
    }

    static func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try JSON.decoder().decode(type, from: data(name))
    }

    static func snapshot() throws -> Snapshot { try decode(Snapshot.self, "snapshot") }
}
