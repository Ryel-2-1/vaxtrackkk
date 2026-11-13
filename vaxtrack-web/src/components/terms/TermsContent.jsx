import { TERMS_INTRO, TERMS_SECTIONS } from "../../services/termsAgreement";
import "./terms.css";

/** The agreement's wording, shared by the sign-up form and the first-sign-in gate. */
export default function TermsContent() {
  return (
    <div className="terms-content">
      <p>{TERMS_INTRO}</p>
      {TERMS_SECTIONS.map((section) => (
        <section key={section.heading}>
          <h3>{section.heading}</h3>
          {section.body.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </section>
      ))}
    </div>
  );
}
