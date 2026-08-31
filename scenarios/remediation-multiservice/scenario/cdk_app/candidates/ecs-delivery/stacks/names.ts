/**
 * Physical resource names for the checkout delivery platform.
 * Kept in one place so every stack agrees on the same literals.
 */
export const NAMES = {
    vpc: 'checkout-platform-vpc',
    cluster: 'checkout-platform',

    apiRepo: 'platform/checkout-api',
    workerRepo: 'platform/checkout-worker',

    apiFamily: 'checkout-api',
    workerFamily: 'checkout-worker',
    apiService: 'checkout-api-svc',
    workerService: 'checkout-worker-svc',
    apiContainer: 'checkout-api',
    workerContainer: 'checkout-worker',

    alb: 'checkout-internal-alb',
    apiTargetGroup: 'checkout-api-tg',

    releaseProject: 'checkout-api-release-build',
    canaryProject: 'checkout-api-canary-build',
    workerProject: 'checkout-worker-nightly-build',

    registryTable: 'checkout-release-registry',
    extraTagParam: '/platform/checkout-api/canary/extra-tag',

    auditFunction: 'checkout-image-audit',
    probeFunction: 'checkout-synthetic-probe',
    auditAlarm: 'checkout-api-image-audit-errors',
    unhealthyAlarm: 'checkout-api-alb-unhealthy-hosts',

    batchRunnerRole: 'checkout-api-batch-runner',
} as const;

export const CONTAINER_PORT = 8080;
