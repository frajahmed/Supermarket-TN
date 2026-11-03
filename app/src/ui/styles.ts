import { StyleSheet } from 'react-native';

/** Gemeinsame Stile der Fachbildschirme – Bildschirme bleiben dadurch kurz. */
export const ui = StyleSheet.create({
  safe: { flex: 1 },
  container: { padding: 16, gap: 12 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 14, padding: 24 },
  title: { fontSize: 24, fontWeight: '700' },
  section: { fontWeight: '700', marginTop: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  input: { borderWidth: 1, borderColor: '#999', borderRadius: 8, padding: 10, flexGrow: 1 },
  primary: { backgroundColor: '#176b87', borderRadius: 8, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center' },
  primaryText: { color: 'white', fontWeight: '700' },
  secondary: { borderWidth: 1, borderColor: '#176b87', borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14, alignItems: 'center' },
  secondaryText: { color: '#176b87', fontWeight: '600' },
  disabled: { opacity: 0.45 },
  card: { borderWidth: 1, borderColor: '#d9e2e6', borderRadius: 10, padding: 12, gap: 4, backgroundColor: 'white' },
  muted: { color: '#5b6b73' },
  error: { color: '#b42318' },
  link: { color: '#176b87', textAlign: 'center' },
  badge: { borderRadius: 10, paddingVertical: 2, paddingHorizontal: 8, overflow: 'hidden', fontSize: 12, fontWeight: '700' },
  warn: { backgroundColor: '#fdf2c8', color: '#7a5b00' },
  danger: { backgroundColor: '#fde2e1', color: '#9b1c15' },
  chip: { borderWidth: 1, borderColor: '#999', borderRadius: 16, paddingVertical: 6, paddingHorizontal: 12 },
  chipActive: { backgroundColor: '#176b87', borderColor: '#176b87' },
  chipActiveText: { color: 'white', fontWeight: '700' },
});
