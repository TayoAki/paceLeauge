// Background tasks must be registered at module scope before any route renders,
// including when iOS relaunches the app in the background to deliver locations.
import '@/features/recording/location-task';
import 'expo-router/entry';
