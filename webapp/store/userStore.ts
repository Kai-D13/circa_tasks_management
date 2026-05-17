'use client'

import { create } from 'zustand'
import { UserProfile } from '@/types'

interface UserStore {
  profile: UserProfile | null
  setProfile: (profile: UserProfile | null) => void
}

export const useUserStore = create<UserStore>((set) => ({
  profile: null,
  setProfile: (profile) => set({ profile }),
}))
