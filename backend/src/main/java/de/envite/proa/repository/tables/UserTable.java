package de.envite.proa.repository.tables;

import java.time.LocalDateTime;
import java.util.HashSet;
import java.util.Set;

import de.envite.proa.entities.authentication.Role;
import jakarta.persistence.CascadeType;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.FetchType;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.OneToMany;
import jakarta.persistence.OneToOne;
import lombok.Getter;
import lombok.Setter;

@Getter
@Setter
@Entity
public class UserTable {

	@Id
	@GeneratedValue(strategy = GenerationType.AUTO)
	public Long id;

	// Unique: the OIDC subject is the immutable identity key. CurrentUserService
	// provisions users by subject; parallel first requests must not be able to
	// create duplicates. Null only for legacy rows that predate the subject
	// binding - they are claimed (backfilled) on the owner's next login.
	@Column(unique = true)
	private String oidcSubject;

	// Mutable profile data synced from the token on every resolve. Deliberately
	// NOT unique: a recycled e-mail address may briefly exist on both the old
	// owner's row and the new owner's freshly provisioned row.
	private String email;
	private String firstName;
	private String lastName;
	private LocalDateTime createdAt;
	private LocalDateTime modifiedAt;
	private Role role;

	@OneToOne(cascade = CascadeType.REMOVE, orphanRemoval = true, fetch = FetchType.LAZY, mappedBy = "user")
	private SettingsTable settings;

	@OneToMany(cascade = CascadeType.REMOVE, orphanRemoval = true, fetch = FetchType.LAZY, mappedBy = "user")
	private Set<ProjectUserRelationTable> userRelations = new HashSet<>();
}