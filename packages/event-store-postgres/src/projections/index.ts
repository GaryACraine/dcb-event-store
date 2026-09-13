export type { Projection, ProjectionContext } from "./projection.js"
export { rawSqlProjection } from "./rawSqlProjection.js"
export type { RawSqlProjectionOptions } from "./rawSqlProjection.js"
export { projectionToProcessor } from "./projectionAdapter.js"
export type { ProjectionProcessorOptions } from "./projectionAdapter.js"
export { ProjectionSpec } from "./projectionSpec.js"
export { pongoProjection } from "./pongo/pongoProjection.js"
export type { PongoProjectionOptions, PongoProjectionContext } from "./pongo/pongoProjection.js"
export { pongoDocumentProjection } from "./pongo/pongoDocumentProjection.js"
export type { PongoDocumentProjectionOptions } from "./pongo/pongoDocumentProjection.js"

export { rebuildProjection } from "./rebuildProjection.js"
export type { RebuildProjectionOptions } from "./rebuildProjection.js"

export {
    registerProjection,
    readProjectionStatus,
    setProjectionStatus,
    serializeCanHandle
} from "./registry/projectionRegistry.js"
export type { ProjectionType, ProjectionStatus, RegisterProjectionOptions } from "./registry/projectionRegistry.js"

export { tryAcquireSharedProjectionLock, acquireExclusiveProjectionLock } from "./projectionLock.js"
export type { SharedProjectionLockResult } from "./projectionLock.js"
