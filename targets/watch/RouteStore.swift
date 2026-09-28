import CoreLocation
import Foundation

/** A planned route from the phone (phone: src/features/watch/watch-routes.ts; docs/ROADMAP.md 5.1). */
struct WatchRoute: Codable, Equatable {
  struct Cue: Codable, Equatable {
    var i: Int
    var turn: String
    var street: String?
  }

  var version: Int
  var id: String
  var name: String
  var distanceM: Double
  var units: String
  /** [latitude, longitude] */
  var points: [[Double]]
  var cues: [Cue]

  enum CodingKeys: String, CodingKey {
    case version, id, name, units, points, cues
    case distanceM = "distance_m"
  }

  var coordinates: [CLLocationCoordinate2D] {
    points.compactMap { p in p.count == 2 ? CLLocationCoordinate2D(latitude: p[0], longitude: p[1]) : nil }
  }

  var distanceText: String {
    let perUnit = units == "imperial" ? 1609.344 : 1000
    return String(format: "%.1f %@", distanceM / perUnit, units == "imperial" ? "mi" : "km")
  }
}

/** The watch keeps one route: the one the phone sent last, for the next run. */
enum RouteStore {
  private static var file: URL {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return base.appendingPathComponent("route.json")
  }

  static func load() -> WatchRoute? {
    guard let data = try? Data(contentsOf: file) else { return nil }
    return try? JSONDecoder().decode(WatchRoute.self, from: data)
  }

  /** Keeps a route the phone sent, if it reads as one. */
  static func save(_ data: Data) -> WatchRoute? {
    guard let route = try? JSONDecoder().decode(WatchRoute.self, from: data), route.version == 1, route.points.count >= 2 else { return nil }
    try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? data.write(to: file, options: .atomic)
    return route
  }

  static func clear() {
    try? FileManager.default.removeItem(at: file)
  }
}
