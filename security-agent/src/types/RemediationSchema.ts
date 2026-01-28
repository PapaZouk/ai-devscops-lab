import z from "../../node_modules/zod/index.cjs";

export const AcionSchema = z.object({
    package: z.string(),
    command: z.string().startsWith('npm install '),
    reason: z.string()
});

export const FixPlanSchema = z.object({
    summary: z.string(),
    actions: z.array(AcionSchema),
    risk_level: z.enum(['low', 'medium', 'high', 'critical'])
});

export type FixPlan = z.infer<typeof FixPlanSchema>;
