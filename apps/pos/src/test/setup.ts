/**
 * Vitest setup for apps/pos — runs before every test file.
 *
 * Installs `fake-indexeddb` so syncQueue's IndexedDB calls land on
 * an in-memory store. jsdom does not ship IndexedDB; without this
 * shim every queue test would fail at openDb().
 */

import 'fake-indexeddb/auto'
