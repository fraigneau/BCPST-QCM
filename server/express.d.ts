declare module 'express' {
  import type { IncomingMessage, ServerResponse } from 'node:http'

  export interface Request extends IncomingMessage {
    body: unknown
    params: Record<string, string>
    query: Record<string, string | string[] | undefined>
    ip: string | undefined
    secure: boolean
    get(name: string): string | undefined
  }

  interface CookieOptions { httpOnly?: boolean; sameSite?: 'strict' | 'lax' | 'none'; secure?: boolean; maxAge?: number; path?: string }

  export interface Response extends ServerResponse {
    locals: Record<string, unknown>
    status(code: number): this
    json(body: unknown): this
    cookie(name: string, value: string, options?: CookieOptions): this
    clearCookie(name: string, options?: CookieOptions): this
    sendFile(path: string): this
  }

  export interface NextFunction { (error?: unknown): void }
  export interface RequestHandler { (req: Request, res: Response, next: NextFunction): unknown }
  export interface ErrorRequestHandler { (error: unknown, req: Request, res: Response, next: NextFunction): unknown }

  export interface Router extends RequestHandler {
    get(path: string, ...handlers: RequestHandler[]): this
    post(path: string, ...handlers: RequestHandler[]): this
    put(path: string, ...handlers: RequestHandler[]): this
    delete(path: string, ...handlers: RequestHandler[]): this
    patch(path: string, ...handlers: RequestHandler[]): this
    use(path: string, ...handlers: RequestHandler[]): this
    use(path: string, ...handlers: ErrorRequestHandler[]): this
    use(...handlers: RequestHandler[]): this
  }

  export interface Application extends Router {
    (req: IncomingMessage, res: ServerResponse): void
    disable(setting: string): this
  }

  interface StaticOptions { dotfiles?: 'allow' | 'deny' | 'ignore'; fallthrough?: boolean; maxAge?: string | number; immutable?: boolean; index?: boolean | string; setHeaders?: (res: ServerResponse, path: string, stat: unknown) => void }
  interface ExpressFactory {
    (): Application
    Router(): Router
    json(options?: { limit?: string | number; strict?: boolean }): RequestHandler
    static(path: string, options?: StaticOptions): RequestHandler
  }

  const express: ExpressFactory
  export default express
}
