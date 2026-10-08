import Foundation

/// A version as releases are tagged: "1.2.0", or "v1.2.0". Anything else (a prerelease's
/// "1.2.0-beta.1") isn't one.
struct AppVersion: Comparable, CustomStringConvertible, Codable, Sendable {
    let parts: [Int]

    init?(_ string: String) {
        let numbers = (string.hasPrefix("v") ? String(string.dropFirst()) : string)
            .split(separator: ".", omittingEmptySubsequences: false)
            .map { $0.allSatisfy { $0.isASCII && $0.isNumber } ? Int($0) : nil }
        guard !numbers.isEmpty, numbers.allSatisfy({ $0 != nil }) else { return nil }
        parts = numbers.compactMap { $0 }
    }

    var description: String { parts.map(String.init).joined(separator: ".") }

    /// As its tag says it.
    init(from decoder: Decoder) throws {
        let text = try decoder.singleValueContainer().decode(String.self)
        guard let version = AppVersion(text) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "\(text) isn't a version"))
        }
        self = version
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(description)
    }

    /// 1.2 and 1.2.0 are the same version.
    private func part(_ i: Int) -> Int { i < parts.count ? parts[i] : 0 }

    static func == (a: Self, b: Self) -> Bool {
        (0..<max(a.parts.count, b.parts.count)).allSatisfy { a.part($0) == b.part($0) }
    }

    static func < (a: Self, b: Self) -> Bool {
        for i in 0..<max(a.parts.count, b.parts.count) where a.part(i) != b.part(i) {
            return a.part(i) < b.part(i)
        }
        return false
    }
}

/// The latest published release, as GitHub's `releases/latest` lists it: drafts and
/// prereleases never are.
struct Release: Equatable, Codable, Sendable {
    /// The asset `make dmg` builds and the release workflow uploads.
    static let dmgName = "Bridgetown.dmg"

    let version: AppVersion
    /// The release page: its notes, and the way to install by hand.
    let page: URL
    let dmg: URL
    /// The DMG's SHA-256, lowercase hex, as GitHub computed it on upload.
    let sha256: String

    #if DEBUG
    /// A made-up release of this repository, for an e2e run or a test.
    static func sample(_ version: String = "1.2.0", dmg: URL? = nil, sha256: String = "") -> Release {
        let base = "https://github.com/\(GitHubReleases.repository)/releases"
        return Release(
            version: AppVersion(version)!, page: URL(string: "\(base)/tag/v\(version)")!,
            dmg: dmg ?? URL(string: "\(base)/download/v\(version)/\(dmgName)")!, sha256: sha256
        )
    }
    #endif
}

extension Release {
    /// Reads GitHub's release JSON. A release without the DMG, or without its digest,
    /// isn't one to install.
    init(json data: Data) throws {
        struct Payload: Decodable {
            struct Asset: Decodable {
                let name: String
                let browser_download_url: URL
                let digest: String?
            }
            let tag_name: String
            let html_url: URL
            let assets: [Asset]
        }
        let payload: Payload
        do {
            payload = try JSONDecoder().decode(Payload.self, from: data)
        } catch {
            throw UpdateError("Couldn't read GitHub's answer")
        }
        guard let version = AppVersion(payload.tag_name) else { throw UpdateError("The latest release, \(payload.tag_name), isn't a version") }
        guard let asset = payload.assets.first(where: { $0.name == Self.dmgName }) else {
            throw UpdateError("Bridgetown \(version) has no \(Self.dmgName) yet")
        }
        guard let digest = asset.digest, digest.hasPrefix("sha256:") else {
            throw UpdateError("Bridgetown \(version) has no checksum for its download")
        }
        self.init(version: version, page: payload.html_url, dmg: asset.browser_download_url, sha256: String(digest.dropFirst(7)).lowercased())
    }
}

/// Bridgetown's releases on GitHub, through its API (unauthenticated: 60 requests an hour
/// is plenty for a check every few hours).
enum GitHubReleases {
    static let repository = "alexandre-schaffner/Bridgetown"

    private static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 30
        c.waitsForConnectivity = false
        return URLSession(configuration: c)
    }()

    static func latest(repository: String = repository) async throws -> Release {
        var request = URLRequest(url: URL(string: "https://api.github.com/repos/\(repository)/releases/latest")!)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { throw UpdateError(status == 404 ? "No release published yet" : "GitHub answered \(status)") }
        return try Release(json: data)
    }
}

/// Why a check or an install didn't go through, as the update notice says it.
struct UpdateError: LocalizedError, Equatable {
    let message: String

    init(_ message: String) { self.message = message }

    var errorDescription: String? { message }
}
