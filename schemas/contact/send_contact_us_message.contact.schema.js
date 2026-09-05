const z = require('zod');
const { CONTACT_US_SUBJECT_ENUM } = require('../../constants');

const sendContactUsMessageSchema = z.object({
    name: z.string({
        error: (issue) => {
            if (issue.input === undefined) {
                return "Full Name is required"
            }
            if (issue.code === "invalid_type") {
                return "Full Name must be string"
            }
        }
    }).trim()
        .min(2, {
            error: (issue) => {
                if (issue.code === "too_small") {
                    return "Full Name must be at least 2 characters long"
                }
            }
        })
        .max(50, {
            error: (issue) => {
                if (issue.code === "too_big") {
                    return "Full Name must be less than 50 characters"
                }
            }
        }),
    email: z.string({
        error: (issue) => {
            if (issue.input === undefined) {
                return "Email is required"
            }
            if (issue.code === "invalid_type") {
                return "Email must be string"
            }
        }
    }).trim()
        .email({
            error: (issue) => {
                if (issue.code === "invalid_format") {
                    return "Invalid Email"
                }
            }
        }),
    phone: z.string({
        error: (issue) => {
            if (issue.input === undefined) {
                return "Phone is required"
            }
            if (issue.code === "invalid_type") {
                return "Phone must be string"
            }
        }
    }).trim()
        .regex(/^[6-9][0-9]{9}$/, {
            error: (issue) => {
                if (issue.code === "invalid_format") {
                    return "Phone number should be 10 digits starting with 6,7,8 or 9"
                }
            }
        }),
    subject: z.preprocess((value) => {
        if (typeof value !== "string") {
            return null;
        }
        return value.trim();
    }, z.enum(Object.values(CONTACT_US_SUBJECT_ENUM), {
        error: (issue) => {
            if (issue.code === "invalid_value") {
                return "Invalid Subject"
            }
        }
    })),
    message: z.string({
        error: (issue) => {
            if (issue.input === undefined) {
                return "Message is required"
            }
            if (issue.code === "invalid_type") {
                return "Message must be string"
            }
        }
    }).trim()
        .min(10, {
            error: (issue) => {
                if (issue.code === "too_small") {
                    return "Message must be at least 10 characters long"
                }
            }
        })
        .max(255, {
            error: (issue) => {
                if (issue.code === "too_big") {
                    return "Message must be less than 255 characters"
                }
            }
        })

}, "Invalid Request Body");


module.exports = sendContactUsMessageSchema;
