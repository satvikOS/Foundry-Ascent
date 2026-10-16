import { type JobQueue } from '@foundry/core';

/**
 * A job queue for processes that must never use one (the migrate custom resource has no queue access). Any
 * call is a programming error and fails loudly.
 */
export const unavailableJobQueue: JobQueue = {
  enqueue: () => Promise.reject(new Error('job queue is not available in this process')),
};
