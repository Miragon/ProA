package de.envite.proa.entities.project;

import lombok.Getter;
import lombok.Setter;

/**
 * Outcome of inviting an e-mail address to a project: if a local user with that e-mail exists,
 * the membership is created immediately ({@link Status#MEMBER_ADDED}); otherwise a pending
 * invitation is stored ({@link Status#INVITATION_PENDING}) and redeemed on the invitee's first
 * login (ADR-0003).
 */
@Getter
@Setter
public class AddContributorResult {

	public enum Status {
		MEMBER_ADDED, INVITATION_PENDING
	}

	private Status status;

	/** The pending invitation; {@code null} when the member was added immediately. */
	private ProjectInvitation invitation;

	public static AddContributorResult memberAdded() {
		AddContributorResult result = new AddContributorResult();
		result.setStatus(Status.MEMBER_ADDED);
		return result;
	}

	public static AddContributorResult invitationPending(ProjectInvitation invitation) {
		AddContributorResult result = new AddContributorResult();
		result.setStatus(Status.INVITATION_PENDING);
		result.setInvitation(invitation);
		return result;
	}
}
