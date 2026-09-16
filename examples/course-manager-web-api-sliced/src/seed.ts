const BASE_URL = process.env["BASE_URL"] ?? "http://localhost:3000"

async function post(path: string, body: unknown, expectedStatus = 201): Promise<void> {
    const url = `${BASE_URL}${path}`
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    })
    const etag = res.headers.get("etag") ?? ""
    const etagSuffix = etag ? ` ETag: ${etag}` : ""
    console.log(`POST ${path} → ${res.status}${etagSuffix}`)
    if (res.status !== expectedStatus) {
        const text = await res.text()
        console.error(`Unexpected status ${res.status} for POST ${path}: ${text}`)
        process.exit(1)
    }
}

// Register courses
await post("/courses", { id: "ts101", title: "Introduction to TypeScript", capacity: 2 })
await post("/courses", { id: "go101", title: "Introduction to Go", capacity: 20 })
await post("/courses", { id: "extra101", title: "Bonus Course", capacity: 5 })

// Register students
await post("/students", { id: "alice", name: "Alice" })
await post("/students", { id: "bob", name: "Bob" })
await post("/students", { id: "charlie", name: "Charlie" })

// Subscriptions
await post("/courses/ts101/subscriptions", { studentId: "alice" })
await post("/courses/ts101/subscriptions", { studentId: "bob" }) // fills ts101
await post("/courses/go101/subscriptions", { studentId: "charlie" })

console.log("Seed complete.")
