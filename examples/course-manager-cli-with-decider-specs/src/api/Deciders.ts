import { decider, IllegalStateError, NotFoundError, ValidationError } from "@dcb-es/event-store"
import {
    CourseWasRegisteredEvent,
    StudentWasRegistered,
    StudentWasSubscribedEvent,
    StudentWasUnsubscribedEvent,
    CourseCapacityWasChangedEvent,
    CourseTitleWasChangedEvent
} from "./Events.js"
import {
    CourseCapacity,
    CourseExists,
    CourseTitle,
    NextStudentNumber,
    StudentAlreadyRegistered,
    StudentAlreadySubscribed,
    StudentSubscriptions
} from "./DecisionModels.js"
import type {
    RegisterCourse,
    RegisterStudent,
    UpdateCourseCapacity,
    UpdateCourseTitle,
    SubscribeStudentToCourse,
    UnsubscribeStudentFromCourse
} from "./Commands.js"

const STUDENT_SUBSCRIPTION_LIMIT = 5

export const registerCourse = decider<RegisterCourse, { courseExists: ReturnType<typeof CourseExists> }>({
    handlers: cmd => ({
        courseExists: CourseExists(cmd.data.id)
    }),
    decide: (cmd, state) => {
        if (state.courseExists) throw new IllegalStateError(`Course with id ${cmd.data.id} already exists`)

        return new CourseWasRegisteredEvent({
            courseId: cmd.data.id,
            title: cmd.data.title,
            capacity: cmd.data.capacity
        })
    }
})

export const registerStudent = decider<
    RegisterStudent,
    {
        studentAlreadyRegistered: ReturnType<typeof StudentAlreadyRegistered>
        nextStudentNumber: ReturnType<typeof NextStudentNumber>
    }
>({
    handlers: cmd => ({
        studentAlreadyRegistered: StudentAlreadyRegistered(cmd.data.id),
        nextStudentNumber: NextStudentNumber()
    }),
    decide: (cmd, state) => {
        if (state.studentAlreadyRegistered)
            throw new IllegalStateError(`Student with id ${cmd.data.id} already registered.`)

        return new StudentWasRegistered({
            studentId: cmd.data.id,
            name: cmd.data.name,
            studentNumber: state.nextStudentNumber
        })
    }
})

export const updateCourseCapacity = decider<
    UpdateCourseCapacity,
    { courseExists: ReturnType<typeof CourseExists>; courseCapacity: ReturnType<typeof CourseCapacity> }
>({
    handlers: cmd => ({
        courseExists: CourseExists(cmd.data.courseId),
        courseCapacity: CourseCapacity(cmd.data.courseId)
    }),
    decide: (cmd, state) => {
        if (!state.courseExists) throw new NotFoundError(`Course ${cmd.data.courseId} doesn't exist.`)
        if (state.courseCapacity.capacity === cmd.data.newCapacity)
            throw new ValidationError("New capacity is the same as the current capacity.")

        return new CourseCapacityWasChangedEvent({
            courseId: cmd.data.courseId,
            newCapacity: cmd.data.newCapacity
        })
    }
})

export const updateCourseTitle = decider<
    UpdateCourseTitle,
    { courseExists: ReturnType<typeof CourseExists>; courseTitle: ReturnType<typeof CourseTitle> }
>({
    handlers: cmd => ({
        courseExists: CourseExists(cmd.data.courseId),
        courseTitle: CourseTitle(cmd.data.courseId)
    }),
    decide: (cmd, state) => {
        if (!state.courseExists) throw new NotFoundError(`Course ${cmd.data.courseId} doesn't exist.`)
        if (state.courseTitle === cmd.data.newTitle)
            throw new ValidationError("New title is the same as the current title.")

        return new CourseTitleWasChangedEvent({
            courseId: cmd.data.courseId,
            newTitle: cmd.data.newTitle
        })
    }
})

export const subscribeStudentToCourse = decider<
    SubscribeStudentToCourse,
    {
        courseExists: ReturnType<typeof CourseExists>
        courseCapacity: ReturnType<typeof CourseCapacity>
        studentAlreadySubscribed: ReturnType<typeof StudentAlreadySubscribed>
        studentSubscriptions: ReturnType<typeof StudentSubscriptions>
    }
>({
    handlers: cmd => ({
        courseExists: CourseExists(cmd.data.courseId),
        courseCapacity: CourseCapacity(cmd.data.courseId),
        studentAlreadySubscribed: StudentAlreadySubscribed({
            courseId: cmd.data.courseId,
            studentId: cmd.data.studentId
        }),
        studentSubscriptions: StudentSubscriptions(cmd.data.studentId)
    }),
    decide: (cmd, state) => {
        if (!state.courseExists) throw new NotFoundError(`Course ${cmd.data.courseId} doesn't exist.`)
        if (state.courseCapacity.subscriberCount >= state.courseCapacity.capacity)
            throw new IllegalStateError(`Course ${cmd.data.courseId} is full.`)
        if (state.studentAlreadySubscribed)
            throw new IllegalStateError(
                `Student ${cmd.data.studentId} already subscribed to course ${cmd.data.courseId}.`
            )
        if (state.studentSubscriptions.subscriptionCount >= STUDENT_SUBSCRIPTION_LIMIT)
            throw new IllegalStateError(
                `Student ${cmd.data.studentId} is already subscribed to the maximum number of courses`
            )

        return new StudentWasSubscribedEvent({
            courseId: cmd.data.courseId,
            studentId: cmd.data.studentId
        })
    }
})

export const unsubscribeStudentFromCourse = decider<
    UnsubscribeStudentFromCourse,
    {
        studentAlreadySubscribed: ReturnType<typeof StudentAlreadySubscribed>
        courseExists: ReturnType<typeof CourseExists>
    }
>({
    handlers: cmd => ({
        studentAlreadySubscribed: StudentAlreadySubscribed({
            courseId: cmd.data.courseId,
            studentId: cmd.data.studentId
        }),
        courseExists: CourseExists(cmd.data.courseId)
    }),
    decide: (cmd, state) => {
        if (!state.courseExists) throw new NotFoundError(`Course ${cmd.data.courseId} doesn't exist.`)
        if (!state.studentAlreadySubscribed)
            throw new NotFoundError(`Student ${cmd.data.studentId} is not subscribed to course ${cmd.data.courseId}.`)

        return new StudentWasUnsubscribedEvent({
            courseId: cmd.data.courseId,
            studentId: cmd.data.studentId
        })
    }
})
