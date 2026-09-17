import { AppendCommand, TaggedEvent, Tags, Query, SequencePosition } from "@dcb-es/event-store"

export const EVENTS_PER_METER = 11

const METER_FIELD_EVENTS = [
    "FirmwareVersionSet",
    "LocationSet",
    "CommissionDateSet",
    "TariffAssigned",
    "NetworkJoined",
    "InitialReadingSet",
    "CalibrationRecorded",
    "ActivationCompleted",
    "MeterReady",
] as const

export function buildMeterCommands(meterStart: number, meterEnd: number): AppendCommand[] {
    const commands: AppendCommand[] = []

    for (let m = meterStart; m < meterEnd; m++) {
        const meterId = `M${String(m + 1).padStart(5, "0")}`
        const serialNumber = `SN${String(m + 1).padStart(8, "0")}`

        commands.push({
            events: [{
                event: { type: "MeterCreated", data: { meterId, serialNumber } },
                tags: Tags.fromObj({ meterId }),
            }],
            condition: {
                failIfEventsMatch: Query.fromItems([
                    { types: ["MeterCreated"], tags: Tags.fromObj({ meterId }) },
                ]),
                after: SequencePosition.initial(),
            },
        })

        commands.push({
            events: [{
                event: { type: "SerialNumberSet", data: { meterId, serialNumber } },
                tags: Tags.fromObj({ meterId, serialNumber }),
            }],
            condition: {
                failIfEventsMatch: Query.fromItems([
                    { types: ["SerialNumberSet"], tags: Tags.fromObj({ meterId, serialNumber }) },
                ]),
                after: SequencePosition.initial(),
            },
        })

        const fieldEvents: TaggedEvent[] = METER_FIELD_EVENTS.map(type => ({
            event: { type, data: { meterId, serialNumber, field: type } },
            tags: Tags.fromObj(
                type === "InitialReadingSet" ? { meterId, serialNumber } : { meterId },
            ),
        }))

        commands.push({ events: fieldEvents })
    }

    return commands
}
