import http from "node:http"
import express, { type Router } from "express"
import type { ErrorToProblemDetailsMapping } from "@dcb-es/event-store-web"
import { problemDetailsMiddleware } from "./middlewares/problemDetailsMiddleware.js"
import { traceIdMiddleware } from "./middlewares/traceIdMiddleware.js"

export type WebApiSetup = (router: Router) => void

export interface ApplicationOptions {
    apis: WebApiSetup[]
    mapError?: ErrorToProblemDetailsMapping
    enableDefaultExpressEtag?: boolean
    disableJsonMiddleware?: boolean
    disableUrlEncodingMiddleware?: boolean
    disableProblemDetailsMiddleware?: boolean
    disableTraceIdMiddleware?: boolean
}

export interface StartApiOptions {
    port?: number
}

export function getApplication(options: ApplicationOptions): express.Express {
    const app = express()
    configureApplication(app, options)
    return app
}

export function configureApplication(app: express.Express, options: ApplicationOptions): void {
    if (!options.enableDefaultExpressEtag) {
        app.set("etag", false)
    }

    if (!options.disableJsonMiddleware) {
        app.use(express.json())
    }

    if (!options.disableUrlEncodingMiddleware) {
        app.use(express.urlencoded({ extended: true }))
    }

    if (!options.disableTraceIdMiddleware) {
        app.use(traceIdMiddleware())
    }

    // Health endpoints registered before user APIs so they're always reachable
    app.get("/health/live", (_req, res) => {
        res.json({ status: "ok" })
    })
    app.get("/health/ready", (_req, res) => {
        res.json({ status: "ok" })
    })

    registerWebApi(app, options.apis)

    if (!options.disableProblemDetailsMiddleware) {
        app.use(problemDetailsMiddleware(options.mapError))
    }
}

export function registerWebApi(app: express.Express, apis: WebApiSetup[]): void {
    const router = express.Router()
    for (const setup of apis) {
        setup(router)
    }
    app.use(router)
}

/**
 * Starts the server. It registers no signal handlers (as Emmett's `startAPI`): each call used to add its own
 * SIGTERM/SIGINT listeners, never removed, racing the app's shutdown. Register the shutdown once with `onShutdown`,
 * stopping the server with `stopAPI`.
 */
export function startAPI(app: express.Express, options?: StartApiOptions): http.Server {
    const port = options?.port ?? 0
    const server = http.createServer(app)

    server.listen(port)

    return server
}

/**
 * Stops the server: no new connections, and the open ones (keep-alive, an SSE feed) are ended rather than waited
 * for, since an event feed never ends by itself. Resolves when the server has closed.
 */
export function stopAPI(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => {
        if (!server.listening) return resolve()
        server.close(err => (err ? reject(err) : resolve()))
        server.closeAllConnections()
    })
}
