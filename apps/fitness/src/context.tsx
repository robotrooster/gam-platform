import { createContext, useContext } from 'react'

export interface Me { id: string; email: string; role: string; firstName: string; lastName: string }

export interface AuthCtxShape { me: Me | null; refresh: () => Promise<void>; logout: () => void }
export const AuthCtx = createContext<AuthCtxShape>({ me: null, refresh: async () => {}, logout: () => {} })
export const useAuth = () => useContext(AuthCtx)

export const ToastCtx = createContext<(m: string) => void>(() => {})
export const useToast = () => useContext(ToastCtx)
