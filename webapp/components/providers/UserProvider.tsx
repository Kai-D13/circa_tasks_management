'use client'

import { useEffect } from 'react'
import { useUserStore } from '@/store/userStore'
import { UserProfile } from '@/types'

export function UserProvider({
  profile,
  children,
}: {
  profile: UserProfile
  children: React.ReactNode
}) {
  const setProfile = useUserStore((s) => s.setProfile)

  useEffect(() => {
    setProfile(profile)
    return () => setProfile(null)
  }, [profile, setProfile])

  return <>{children}</>
}
