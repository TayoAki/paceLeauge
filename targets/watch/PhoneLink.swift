import Foundation
import WatchConnectivity
import WidgetKit

/** A run as the watch hands it to the phone (phone: src/features/watch/watch-runs.ts). */
struct WatchRunFile: Codable {
  var version: Int
  var runId: String
  var startedAt: Double
  var endedAt: Double
  /** Active stretches as [start ms, end ms]. */
  var segments: [[Double]]
  /** GPS fixes as [t ms, latitude, longitude, accuracy m]. */
  var points: [[Double]]
  var distanceM: Double
  var indoor: Bool
  var avgHeartRate: Double?
  var maxHeartRate: Double?
  var steps: Double?
  var device: String?

  enum CodingKeys: String, CodingKey {
    case version, segments, points, indoor, steps, device
    case runId = "run_id"
    case startedAt = "started_at"
    case endedAt = "ended_at"
    case distanceM = "distance_m"
    case avgHeartRate = "avg_heart_rate"
    case maxHeartRate = "max_heart_rate"
  }
}

/**
 * The watch's side of WatchConnectivity: the phone's context (units, cues, week and league) comes
 * in as application context; finished runs go out as queued file transfers, which the system
 * delivers whenever the phone is next in reach, even hours later; a planned route comes in the
 * same way (docs/ROADMAP.md 5.1).
 */
@MainActor
final class PhoneLink: NSObject, ObservableObject {
  @Published private(set) var context = SharedStore.loadContext()
  /** The route for the next run, until the runner clears it. */
  @Published private(set) var route: WatchRoute? = RouteStore.load()

  func clearRoute() {
    RouteStore.clear()
    route = nil
  }

  func activate() {
    guard WCSession.isSupported() else { return }
    WCSession.default.delegate = self
    WCSession.default.activate()
  }

  func send(run: WatchRunFile) {
    guard let data = try? JSONEncoder().encode(run) else { return }
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("outgoing-runs", isDirectory: true)
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let file = folder.appendingPathComponent("\(run.runId).json")
    do {
      try data.write(to: file, options: .atomic)
      WCSession.default.transferFile(file, metadata: ["kind": "run", "run_id": run.runId])
    } catch {
      // Apple Health still has the workout; the phone imports it from there.
    }
  }

  fileprivate func apply(_ applicationContext: [String: Any]) {
    guard let json = applicationContext["context"] as? String, let data = json.data(using: .utf8),
          let next = try? JSONDecoder().decode(PhoneContext.self, from: data)
    else { return }
    context = next
    SharedStore.saveContext(next)
    WidgetCenter.shared.reloadAllTimelines()
  }
}

extension PhoneLink: WCSessionDelegate {
  nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
    let latest = session.receivedApplicationContext
    Task { @MainActor in apply(latest) }
  }

  nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
    Task { @MainActor in apply(applicationContext) }
  }

  nonisolated func session(_ session: WCSession, didReceive file: WCSessionFile) {
    // The system deletes the file after this returns, so read it now.
    guard file.metadata?["kind"] as? String == "route", let data = try? Data(contentsOf: file.fileURL) else { return }
    guard let route = RouteStore.save(data) else { return }
    Task { @MainActor in self.route = route }
  }

  nonisolated func session(_ session: WCSession, didFinish fileTransfer: WCSessionFileTransfer, error: Error?) {
    // Delivered: the local copy can go. On error the system keeps retrying on its own.
    if error == nil {
      try? FileManager.default.removeItem(at: fileTransfer.file.fileURL)
    }
  }
}
