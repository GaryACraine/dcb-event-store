import { EventStore, handle } from "@dcb-es/event-store"
import {
    registerCourse,
    registerStudent,
    updateCourseCapacity,
    updateCourseTitle,
    subscribeStudentToCourse,
    unsubscribeStudentFromCourse
} from "./Deciders.js"

export class Api {
    constructor(private eventStore: EventStore) {}

    async registerCourse(cmd: { id: string; title: string; capacity: number }) {
        await handle(this.eventStore, registerCourse, {
            type: "registerCourse",
            data: cmd
        })
    }

    async registerStudent(cmd: { id: string; name: string }) {
        await handle(this.eventStore, registerStudent, {
            type: "registerStudent",
            data: cmd
        })
    }

    async updateCourseCapacity(cmd: { courseId: string; newCapacity: number }) {
        await handle(this.eventStore, updateCourseCapacity, {
            type: "updateCourseCapacity",
            data: cmd
        })
    }

    async updateCourseTitle(cmd: { courseId: string; newTitle: string }) {
        await handle(this.eventStore, updateCourseTitle, {
            type: "updateCourseTitle",
            data: cmd
        })
    }

    async subscribeStudentToCourse(cmd: { courseId: string; studentId: string }) {
        await handle(this.eventStore, subscribeStudentToCourse, {
            type: "subscribeStudentToCourse",
            data: cmd
        })
    }

    async unsubscribeStudentFromCourse(cmd: { courseId: string; studentId: string }) {
        await handle(this.eventStore, unsubscribeStudentFromCourse, {
            type: "unsubscribeStudentFromCourse",
            data: cmd
        })
    }
}
