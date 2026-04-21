import { supabase } from './supabase'

const TABLE = 'reports'
const MIGRATION_FLAG = 'reports:migrated'

// Per-user Supabase-backed storage adapter.
// Keeps the same { get, set, delete } interface the app already uses.
export function createStorage(userId) {
  return {
    async get(key) {
      const { data, error } = await supabase
        .from(TABLE)
        .select('value')
        .eq('user_id', userId)
        .eq('key', key)
        .maybeSingle()
      if (error) {
        console.error('[storage.get]', error)
        return null
      }
      if (!data) return null
      return { key, value: data.value }
    },

    async set(key, value) {
      const { error } = await supabase
        .from(TABLE)
        .upsert(
          {
            user_id: userId,
            key,
            value,
            updated_at: new Date().toISOString()
          },
          { onConflict: 'user_id,key' }
        )
      if (error) {
        console.error('[storage.set]', error)
        throw error
      }
      return { key, value }
    },

    async delete(key) {
      const { error } = await supabase
        .from(TABLE)
        .delete()
        .eq('user_id', userId)
        .eq('key', key)
      if (error) {
        console.error('[storage.delete]', error)
      }
      return { key, deleted: true }
    }
  }
}

// One-time migration: if user has data in localStorage but nothing in Supabase
// for this account, copy it up. Marks a flag in localStorage so it won't retry.
export async function migrateFromLocalStorage(storage, userId) {
  const flagKey = `${MIGRATION_FLAG}:${userId}`
  if (localStorage.getItem(flagKey)) return { migrated: false, reason: 'already-done' }

  const localData = localStorage.getItem('reports:data')
  const localRecurring = localStorage.getItem('reports:recurring')
  if (!localData && !localRecurring) {
    localStorage.setItem(flagKey, '1')
    return { migrated: false, reason: 'no-local-data' }
  }

  // Don't overwrite existing cloud data
  const existingData = await storage.get('reports:data')
  const existingRecurring = await storage.get('reports:recurring')

  let migrated = false
  if (localData && !existingData?.value) {
    await storage.set('reports:data', localData)
    migrated = true
  }
  if (localRecurring && !existingRecurring?.value) {
    await storage.set('reports:recurring', localRecurring)
    migrated = true
  }

  localStorage.setItem(flagKey, '1')
  return { migrated, reason: migrated ? 'copied' : 'cloud-already-has-data' }
}
