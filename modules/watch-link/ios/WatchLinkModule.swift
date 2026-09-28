import ExpoModulesCore
import HealthKit
import WatchConnectivity

/**
 * The phone side of the PaceLeague Apple Watch app (docs/ROADMAP.md 2.2):
 *  - context to the watch (units, cues, the week and the league) as WatchConnectivity application
 *    context, which the watch always gets the latest of;
 *  - finished runs from the watch as queued file transfers, kept in Application Support until the
 *    app has saved them (src/features/watch/watch-runs.ts);
 *  - the live run from the watch through workout mirroring (iOS 17), for the Today screen;
 *  - a planned route to the watch as a queued file transfer (docs/ROADMAP.md 5.1), one at a time.
 */
public class WatchLinkModule: Module {
  private let link = WatchLink()

  public func definition() -> ModuleDefinition {
    Name("WatchLink")

    Events("onWatchRun", "onWatchWorkout")

    OnCreate {
      self.link.onRun = { [weak self] name in
        self?.sendEvent("onWatchRun", ["name": name])
      }
      self.link.onWorkout = { [weak self] payload in
        self?.sendEvent("onWatchWorkout", payload)
      }
      self.link.activate()
    }

    Function("status") { () -> [String: Bool] in
      self.link.status()
    }

    Function("updateContext") { (json: String) -> Bool in
      self.link.update(context: json)
    }

    Function("pendingRuns") { () -> [[String: String]] in
      self.link.pendingRuns()
    }

    Function("ackRun") { (name: String) in
      self.link.ack(name: name)
    }

    Function("sendRoute") { (json: String) -> Bool in
      self.link.send(route: json)
    }
  }
}

final class WatchLink: NSObject, WCSessionDelegate {
  var onRun: ((String) -> Void)?
  var onWorkout: (([String: Any]) -> Void)?
  private let healthStore = HKHealthStore()
  /** The mirrored session's delegate (iOS 17), kept alive while a watch run lasts. */
  private var mirror: AnyObject?

  private var inbox: URL {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return base.appendingPathComponent("watch-runs", isDirectory: true)
  }

  func activate() {
    if WCSession.isSupported() {
      WCSession.default.delegate = self
      WCSession.default.activate()
    }
    if #available(iOS 17.0, *), HKHealthStore.isHealthDataAvailable() {
      // Set as early as possible: the system launches the app in the background to hand it over.
      healthStore.workoutSessionMirroringStartHandler = { [weak self] session in
        guard let self else { return }
        let delegate = MirroredWorkout(session: session) { [weak self] payload in
          self?.onWorkout?(payload)
          if payload["state"] as? String == "ended" { self?.mirror = nil }
        }
        self.mirror = delegate
        self.onWorkout?(["state": "running"])
      }
    }
  }

  func status() -> [String: Bool] {
    guard WCSession.isSupported() else { return ["supported": false, "paired": false, "installed": false, "reachable": false] }
    let session = WCSession.default
    let active = session.activationState == .activated
    return [
      "supported": true,
      "paired": active && session.isPaired,
      "installed": active && session.isWatchAppInstalled,
      "reachable": active && session.isReachable,
    ]
  }

  func update(context json: String) -> Bool {
    guard WCSession.isSupported(), WCSession.default.activationState == .activated, WCSession.default.isWatchAppInstalled else { return false }
    do {
      try WCSession.default.updateApplicationContext(["context": json])
      return true
    } catch {
      return false
    }
  }

  /** A planned route for the watch's next run; one still waiting to go is replaced. */
  func send(route json: String) -> Bool {
    guard WCSession.isSupported(), WCSession.default.activationState == .activated, WCSession.default.isWatchAppInstalled else { return false }
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("outgoing-routes", isDirectory: true)
    do {
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      for transfer in WCSession.default.outstandingFileTransfers where transfer.file.metadata?["kind"] as? String == "route" {
        transfer.cancel()
      }
      let file = folder.appendingPathComponent("route-\(UUID().uuidString).json")
      try json.write(to: file, atomically: true, encoding: .utf8)
      WCSession.default.transferFile(file, metadata: ["kind": "route"])
      return true
    } catch {
      return false
    }
  }

  func pendingRuns() -> [[String: String]] {
    let files = (try? FileManager.default.contentsOfDirectory(at: inbox, includingPropertiesForKeys: nil)) ?? []
    return files
      .filter { $0.pathExtension == "json" }
      .sorted { $0.lastPathComponent < $1.lastPathComponent }
      .compactMap { url in
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        return ["name": url.lastPathComponent, "json": text]
      }
  }

  func ack(name: String) {
    // Only a plain file name inside the inbox.
    guard !name.contains("/"), name.hasSuffix(".json") else { return }
    try? FileManager.default.removeItem(at: inbox.appendingPathComponent(name))
  }

  // MARK: WCSessionDelegate

  func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}

  func session(_ session: WCSession, didFinish fileTransfer: WCSessionFileTransfer, error: Error?) {
    // A route that reached the watch (or was replaced) needn't stay here.
    if fileTransfer.file.metadata?["kind"] as? String == "route" {
      try? FileManager.default.removeItem(at: fileTransfer.file.fileURL)
    }
  }

  func sessionDidBecomeInactive(_ session: WCSession) {}

  func sessionDidDeactivate(_ session: WCSession) {
    // A different watch was paired: start again with it.
    WCSession.default.activate()
  }

  func session(_ session: WCSession, didReceive file: WCSessionFile) {
    // The system deletes the file after this returns, so keep a copy now.
    guard file.metadata?["kind"] as? String == "run" else { return }
    let runId = (file.metadata?["run_id"] as? String) ?? UUID().uuidString
    let safe = runId.filter { $0.isLetter || $0.isNumber || $0 == "-" }
    do {
      try FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)
      let target = inbox.appendingPathComponent("\(safe).json")
      if FileManager.default.fileExists(atPath: target.path) {
        try FileManager.default.removeItem(at: target)
      }
      try FileManager.default.copyItem(at: file.fileURL, to: target)
      onRun?(target.lastPathComponent)
    } catch {
      // The watch still saved the workout to Apple Health, which the app imports.
    }
  }
}

/** Follows the watch's run while it is mirrored to the phone. */
@available(iOS 17.0, *)
final class MirroredWorkout: NSObject, HKWorkoutSessionDelegate {
  private let session: HKWorkoutSession
  private let emit: ([String: Any]) -> Void

  init(session: HKWorkoutSession, emit: @escaping ([String: Any]) -> Void) {
    self.session = session
    self.emit = emit
    super.init()
    session.delegate = self
  }

  func workoutSession(_ workoutSession: HKWorkoutSession, didChangeTo toState: HKWorkoutSessionState, from fromState: HKWorkoutSessionState, date: Date) {
    switch toState {
    case .running: emit(["state": "running"])
    case .paused: emit(["state": "paused"])
    case .ended, .stopped: emit(["state": "ended"])
    default: break
    }
  }

  func workoutSession(_ workoutSession: HKWorkoutSession, didFailWithError error: Error) {
    emit(["state": "ended"])
  }

  func workoutSession(_ workoutSession: HKWorkoutSession, didReceiveDataFromRemoteWorkoutSession data: [Data]) {
    for item in data {
      if let payload = try? JSONSerialization.jsonObject(with: item) as? [String: Any] {
        emit(payload)
      }
    }
  }

  func workoutSession(_ workoutSession: HKWorkoutSession, didDisconnectFromRemoteDeviceWithError error: Error?) {
    emit(["state": "ended"])
  }
}
