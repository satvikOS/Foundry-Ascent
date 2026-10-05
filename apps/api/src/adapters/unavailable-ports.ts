import { type JobQueue, type ObjectStore } from '@foundry/core';

/**
 * Ports for processes that must never use them (the migrate custom resource has no bucket or queue
 * access). Any call is a programming error and fails loudly.
 */
export const unavailableObjectStore: ObjectStore = {
  presignPut: () => Promise.reject(new Error('object store is not available in this process')),
  getObject: () => Promise.reject(new Error('object store is not available in this process')),
  delete: () => Promise.reject(new Error('object store is not available in this process')),
};

export const unavailableJobQueue: JobQueue = {
  enqueue: () => Promise.reject(new Error('job queue is not available in this process')),
};
