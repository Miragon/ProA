package de.envite.proa.usecases.user;

import de.envite.proa.entities.authentication.User;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;

@ApplicationScoped
public class UserUsecase {

	@Inject
	UserRepository repository;

	public User findById(Long id) {
		return repository.findById(id);
	}
}
