/**
 * PiAdapter — shape type for the stock Pi (`piAgent`) provider adapter.
 *
 * @module PiAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface PiAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
