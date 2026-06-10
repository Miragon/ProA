package de.envite.proa.usecases.processmodel;

/**
 * Lightweight domain reference to an already persisted process model. Returned by the
 * {@link ProcessModelRepository} port so that the use case layer does not depend on
 * persistence types.
 */
public record ProcessModelReference(Long id) {
}
