import type { NextFunction, Request, Response } from "express"

export type HttpResponse = (response: Response) => void

export type HttpHandler<Req extends Request = Request> = (
    request: Req
) => Promise<HttpResponse> | HttpResponse

export const on =
    <Req extends Request = Request>(handle: HttpHandler<Req>) =>
    async (request: Req, response: Response, next: NextFunction): Promise<void> => {
        try {
            const setResponse = await Promise.resolve(handle(request))
            setResponse(response)
        } catch (error) {
            next(error)
        }
    }
