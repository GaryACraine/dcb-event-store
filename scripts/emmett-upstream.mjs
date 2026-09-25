#!/usr/bin/env node
// Lists the Emmett PRs merged since UPSTREAM.md's baseline that touch a path we watch and aren't in its review log,
// each with the files of ours it maps to. Read-only: it changes nothing but, with --fetch, the reference clone.
//
//   pnpm upstream:emmett            list what's untriaged
//   pnpm upstream:emmett --fetch    also fast-forward the reference clone (../emmett, or EMMETT_DIR)
//   pnpm upstream:emmett --check    exit 1 while anything is untriaged
//   UPSTREAM_FILE=<path>            read another copy of UPSTREAM.md (to try the script)
//
// Needs the GitHub CLI (`gh`), signed in.

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const REPO = "event-driven-io/emmett"
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const args = new Set(process.argv.slice(2))

/** The rows of the markdown table under `## <heading>`, as arrays of cells (backticks stripped). */
export function tableUnder(markdown, heading) {
    const lines = markdown.split("\n")
    const start = lines.findIndex(l => l.trim() === `## ${heading}`)
    if (start === -1) throw new Error(`UPSTREAM.md has no "## ${heading}" section`)
    const rows = []
    for (const line of lines.slice(start + 1)) {
        if (line.startsWith("## ")) break
        if (!line.trim().startsWith("|")) continue
        const cells = line
            .trim()
            .replace(/^\||\|$/g, "")
            .split("|")
            .map(c => c.trim().replace(/`/g, ""))
        if (cells.every(c => /^-*$/.test(c))) continue
        rows.push(cells)
    }
    return rows.slice(1) // the header
}

export function readUpstream(markdown) {
    const baseline = /^Baseline: (\w+) \((\d{4}-\d{2}-\d{2})\)/m.exec(markdown)
    if (!baseline) throw new Error('UPSTREAM.md has no "Baseline: <sha> (<yyyy-mm-dd>)" line')
    return {
        baseline: { sha: baseline[1], date: baseline[2] },
        watched: tableUnder(markdown, "Watched paths").map(([prefix, status]) => ({ prefix, status })),
        map: tableUnder(markdown, "File map").map(([ours, emmett, how]) => ({
            ours,
            emmett: emmett.split(",").map(s => s.trim()),
            how
        })),
        reviewed: new Set(tableUnder(markdown, "Review log").map(([pr]) => Number(pr)))
    }
}

/** What a PR's files touch: the watched ones, and the file-map rows they fall under. */
export function triage(pr, { watched, map }) {
    const watchedFiles = pr.files.filter(file => {
        const rule = watched.filter(w => file.startsWith(w.prefix)).sort((a, b) => b.prefix.length - a.prefix.length)[0]
        return rule && rule.status !== "ignore"
    })
    const mapped = map.filter(row =>
        row.emmett.some(e => watchedFiles.some(file => file.startsWith(e) || file.startsWith(e.replace(/\.ts$/, ""))))
    )
    return { watchedFiles, mapped }
}

function main() {
    const upstream = readUpstream(readFileSync(process.env.UPSTREAM_FILE ?? path.join(root, "UPSTREAM.md"), "utf8"))

    if (args.has("--fetch")) {
        const clone = process.env.EMMETT_DIR ?? path.resolve(root, "../emmett")
        if (!existsSync(clone)) console.log(`No reference clone at ${clone}; skipping --fetch.`)
        else {
            execFileSync("git", ["-C", clone, "pull", "--ff-only", "--quiet"], { stdio: "inherit" })
            const head = execFileSync("git", ["-C", clone, "log", "-1", "--format=%h %cs %s"], { encoding: "utf8" })
            console.log(`Reference clone ${clone} at ${head.trim()}`)
        }
    }

    const prs = JSON.parse(
        execFileSync(
            "gh",
            [
                "pr",
                "list",
                "--repo",
                REPO,
                "--state",
                "merged",
                "--limit",
                "200",
                "--search",
                `merged:>=${upstream.baseline.date}`,
                "--json",
                "number,title,mergedAt,url,files"
            ],
            { encoding: "utf8" }
        )
    ).map(pr => ({ ...pr, files: pr.files.map(f => f.path) }))

    const untriaged = prs.filter(pr => !upstream.reviewed.has(pr.number)).sort((a, b) => a.number - b.number)
    const relevant = []
    let quiet = 0
    for (const pr of untriaged) {
        const t = triage(pr, upstream)
        if (t.watchedFiles.length === 0) quiet++
        else relevant.push({ pr, ...t })
    }

    console.log(
        `Emmett PRs merged since ${upstream.baseline.date} (baseline ${upstream.baseline.sha}): ${prs.length}; ` +
            `${prs.length - untriaged.length} in the review log, ${relevant.length} to triage, ` +
            `${quiet} touching nothing we watch.`
    )
    for (const { pr, watchedFiles, mapped } of relevant) {
        console.log(`\n#${pr.number} ${pr.mergedAt.slice(0, 10)} ${pr.title}\n  ${pr.url}`)
        for (const file of watchedFiles.slice(0, 12)) console.log(`  touches ${file}`)
        if (watchedFiles.length > 12) console.log(`  … and ${watchedFiles.length - 12} more watched files`)
        for (const row of mapped) console.log(`  ← ours: ${row.ours} (${row.how.split(";")[0]})`)
        if (mapped.length === 0) console.log("  ← ours: nothing mapped (a watched path we haven't adapted)")
    }
    if (relevant.length > 0)
        console.log("\nAdd each to UPSTREAM.md's review log with a verdict (take, pattern, later, n/a).")
    if (quiet > 0)
        console.log(
            `Untriaged but touching nothing we watch: ${untriaged
                .filter(pr => !relevant.some(r => r.pr.number === pr.number))
                .map(pr => `#${pr.number}`)
                .join(", ")} (log them as n/a).`
        )

    if (args.has("--check") && untriaged.length > 0) process.exit(1)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
