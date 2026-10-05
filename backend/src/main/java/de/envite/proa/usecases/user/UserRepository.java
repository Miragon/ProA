package de.envite.proa.usecases.user;

import de.envite.proa.entities.authentication.User;

public interface UserRepository {

	User findById(Long id);
}
