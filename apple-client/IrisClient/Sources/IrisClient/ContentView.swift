import SwiftUI

struct ContentView: View {
    @State private var question: String = ""
    @State private var answer: String = ""
    @State private var isAsking: Bool = false
    @State private var askError: String?

    @State private var nudges: [Nudge] = []
    @State private var nudgesError: String?

    // Tracking the in-flight ask task explicitly so a second question
    // cancels whatever the first one was still waiting on, instead of
    // both racing to write `answer` and leaving it showing whichever
    // response happened to land last.
    @State private var askTask: Task<Void, Never>?

    private let client = IrisAPIClient()

    var body: some View {
        NavigationSplitView {
            List {
                Section("Nudges") {
                    if let nudgesError {
                        Text(nudgesError).foregroundStyle(.red)
                    } else if nudges.isEmpty {
                        Text("Nothing open right now.").foregroundStyle(.secondary)
                    } else {
                        ForEach(nudges) { nudge in
                            VStack(alignment: .leading) {
                                Text(nudge.title).font(.headline)
                                if let body = nudge.body {
                                    Text(body).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Iris")
            .task { await loadNudges() }
            .refreshable { await loadNudges() }
        } detail: {
            VStack(alignment: .leading, spacing: 12) {
                TextField("Ask Iris something…", text: $question)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(ask)

                HStack {
                    Button("Ask", action: ask)
                        .disabled(question.trimmingCharacters(in: .whitespaces).isEmpty || isAsking)
                    if isAsking {
                        ProgressView().controlSize(.small)
                    }
                }

                if let askError {
                    Text(askError).foregroundStyle(.red)
                }

                ScrollView {
                    Text(answer)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
            }
            .padding()
            .navigationTitle("Ask")
        }
    }

    private func ask() {
        let trimmed = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        askTask?.cancel()
        askError = nil
        isAsking = true

        askTask = Task {
            defer { isAsking = false }
            do {
                let result = try await client.ask(trimmed)
                if !Task.isCancelled {
                    answer = result
                }
            } catch is CancellationError {
                // superseded by a newer question — nothing to show
            } catch {
                if !Task.isCancelled {
                    askError = error.localizedDescription
                }
            }
        }
    }

    private func loadNudges() async {
        nudgesError = nil
        do {
            nudges = try await client.fetchNudges()
        } catch {
            nudgesError = error.localizedDescription
        }
    }
}

#Preview {
    ContentView()
}
