import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql"

let container: StartedPostgreSqlContainer

export async function setup() {
    container = await new PostgreSqlContainer("postgres:18.6").withDatabase("postgres").start()
    process.env.__PG_CONNECTION_URI = container.getConnectionUri()
}

export async function teardown() {
    await container?.stop()
}
