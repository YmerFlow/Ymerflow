import logging
from backend.config import settings

logger = logging.getLogger(__name__)


async def send_invite_email(to_email: str, inviter_name: str, project_name: str, token: str):
    invite_url = f"{settings.frontend_base_url}/invite/{token}"

    if not settings.smtp_host:
        logger.info(f"[DEV] Invite URL for {to_email}: {invite_url}")
        return

    try:
        import aiosmtplib
        from email.mime.multipart import MIMEMultipart
        from email.mime.text import MIMEText

        msg = MIMEMultipart('alternative')
        msg['Subject'] = f"You've been invited to join {project_name} on YmerFlow"
        msg['From'] = settings.smtp_from_email
        msg['To'] = to_email

        html = f"""
        <p>Hello,</p>
        <p><strong>{inviter_name}</strong> has invited you to join
        <strong>{project_name}</strong> on YmerFlow.</p>
        <p><a href="{invite_url}">Click here to accept the invitation</a></p>
        <p>This invitation expires in 7 days.</p>
        """
        msg.attach(MIMEText(html, 'html'))

        await aiosmtplib.send(
            msg,
            hostname=settings.smtp_host,
            port=settings.smtp_port,
            username=settings.smtp_username,
            password=settings.smtp_password,
        )
        logger.info(f"Invite email sent to {to_email}")
    except Exception as e:
        logger.error(f"Failed to send invite email to {to_email}: {e}")
