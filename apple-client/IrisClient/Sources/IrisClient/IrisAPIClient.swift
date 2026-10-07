import Foundation

struct AskResponse: Codable {
    let question: String
    let answer: String
}

struct Nudge: Codable, Identifiable {
    let id: String
    let title: String
    let body: String?
    let sentAt: Date?
}

struct NudgesResponse: Codable {
    let nudges: [Nudge]
}

struct APIErrorBody: Codable {
    let error: String
}

enum IrisAPIError: Error, LocalizedError {
    case server(String)
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .server(let message): return message
        case .invalidResponse: return "The server returned an unexpected response."
        }
    }
}

/// Talks to Iris's admin server JSON API (src/admin/server.ts's /api/* routes).
/// An actor, not a plain struct/class, so concurrent calls from the UI can't
/// race on shared state here — there isn't much state yet (just the base
/// URL and a shared URLSession), but the isolation is free and the pattern
/// is what grows correctly as this client gains more than two endpoints.
actor IrisAPIClient {
    private let baseURL: URL
    private let session: URLSession
    private let decoder: JSONDecoder

    init(baseURL: URL = URL(string: "http://127.0.0.1:4000")!) {
        self.baseURL = baseURL
        self.session = URLSession(configuration: .ephemeral)
        self.decoder = JSONDecoder()
        self.decoder.dateDecodingStrategy = .iso8601
    }

    func ask(_ question: String) async throws -> String {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/ask"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["question": question])

        let (data, response) = try await session.data(for: request)
        try Self.checkStatus(response, data: data, decoder: decoder)

        let decoded = try decoder.decode(AskResponse.self, from: data)
        return decoded.answer
    }

    func fetchNudges() async throws -> [Nudge] {
        let request = URLRequest(url: baseURL.appendingPathComponent("api/nudges"))
        let (data, response) = try await session.data(for: request)
        try Self.checkStatus(response, data: data, decoder: decoder)

        let decoded = try decoder.decode(NudgesResponse.self, from: data)
        return decoded.nudges
    }

    private static func checkStatus(_ response: URLResponse, data: Data, decoder: JSONDecoder) throws {
        guard let http = response as? HTTPURLResponse else {
            throw IrisAPIError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            if let body = try? decoder.decode(APIErrorBody.self, from: data) {
                throw IrisAPIError.server(body.error)
            }
            throw IrisAPIError.server("Request failed with status \(http.statusCode)")
        }
    }
}
