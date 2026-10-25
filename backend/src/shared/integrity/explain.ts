/**
 * Jan-Sahayak: a deterministic, rule-based explainer of where something stands.
 *
 * Deliberately NOT a language model. Every sentence below is fixed text chosen by
 * a rule, so the same state always produces the same explanation, nothing is
 * invented, and nothing can be talked into giving legal advice. The boundary is
 * printed on every screen that uses it (`BOUNDARY`): this explains process and
 * status only.
 *
 * The Hindi and Marathi copy has NOT been reviewed by a native speaker. That is
 * recorded in docs/JAN_SAHAYAK.md and must stay true until somebody does it.
 */

export type Lang = "en" | "hi" | "mr";
export const LANGS: Lang[] = ["en", "hi", "mr"];

export interface Explanation {
  /** One short line. */
  title: string;
  /** What this means, in plain words. */
  body: string;
  /** What the person can do next, if anything. */
  next: string | null;
  /** For colour-independent display: an icon and a word, never colour alone. */
  tone: "ok" | "pending" | "attention" | "problem";
}

type Text = Record<Lang, string>;
const t = (en: string, hi: string, mr: string): Text => ({ en, hi, mr });

function pick(lang: Lang, text: Text): string {
  return text[lang] ?? text.en;
}

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => (key in values ? String(values[key]) : `{${key}}`));
}

export const BOUNDARY: Text = t(
  "This explains status and process only. It is not legal advice. For advice about your case, speak to a lawyer or the free legal aid service.",
  "यह केवल स्थिति और प्रक्रिया समझाता है। यह कानूनी सलाह नहीं है। अपने मामले पर सलाह के लिए वकील या निःशुल्क विधिक सहायता सेवा से बात करें।",
  "हे फक्त स्थिती आणि प्रक्रिया समजावते. हा कायदेशीर सल्ला नाही. तुमच्या प्रकरणाबद्दल सल्ल्यासाठी वकील किंवा मोफत विधी सहाय्य सेवेशी बोला."
);

export function boundary(lang: Lang): string {
  return pick(lang, BOUNDARY);
}

/* ------------------------------------------------------------ evidence state */

export type VerificationState =
  | "LOCAL_ONLY"
  | "SUBMITTED"
  | "CONFIRMED"
  | "INTEGRITY_MISMATCH"
  | "SYNC_ERROR"
  | "REVIEW_REQUIRED";

const EVIDENCE: Record<VerificationState, { title: Text; body: Text; next: Text | null; tone: Explanation["tone"] }> = {
  LOCAL_ONLY: {
    title: t("Recorded on the device only", "केवल डिवाइस पर दर्ज", "फक्त उपकरणावर नोंद"),
    body: t(
      "The item and its fingerprint (hash) are saved on the device that captured it. Nothing has reached the server or the blockchain yet, so it is not verified.",
      "वस्तु और उसका फ़िंगरप्रिंट (हैश) उसी डिवाइस पर सहेजा गया है जिसने उसे लिया। अभी कुछ भी सर्वर या ब्लॉकचेन तक नहीं पहुँचा है, इसलिए यह सत्यापित नहीं है।",
      "वस्तू आणि तिचा फिंगरप्रिंट (हॅश) ज्या उपकरणाने घेतला त्यावरच जतन आहे. अजून काहीही सर्व्हर किंवा ब्लॉकचेनपर्यंत पोहोचलेले नाही, म्हणून ते सत्यापित नाही."
    ),
    next: t(
      "It will be sent automatically when the device is online.",
      "डिवाइस ऑनलाइन होने पर यह अपने-आप भेजा जाएगा।",
      "उपकरण ऑनलाइन झाल्यावर ते आपोआप पाठवले जाईल."
    ),
    tone: "pending",
  },
  SUBMITTED: {
    title: t("Sent to the blockchain, not yet confirmed", "ब्लॉकचेन को भेजा गया, अभी पुष्टि नहीं", "ब्लॉकचेनकडे पाठवले, अजून पुष्टी नाही"),
    body: t(
      "The fingerprint has been sent to the blockchain. It counts as confirmed only after the network has accepted it and enough further blocks have been added on top.",
      "फ़िंगरप्रिंट ब्लॉकचेन को भेज दिया गया है। इसे तभी पुष्ट माना जाता है जब नेटवर्क इसे स्वीकार कर ले और उसके ऊपर पर्याप्त और ब्लॉक जुड़ जाएँ।",
      "फिंगरप्रिंट ब्लॉकचेनकडे पाठवला आहे. नेटवर्कने तो स्वीकारल्यानंतर आणि त्यावर पुरेसे ब्लॉक जोडले गेल्यानंतरच तो पुष्टीकृत मानला जातो."
    ),
    next: t("No action needed. This usually takes a few minutes.", "कोई कार्रवाई आवश्यक नहीं। इसमें आमतौर पर कुछ मिनट लगते हैं।", "कोणतीही कृती आवश्यक नाही. याला साधारणपणे काही मिनिटे लागतात."),
    tone: "pending",
  },
  CONFIRMED: {
    title: t("Confirmed on the blockchain", "ब्लॉकचेन पर पुष्टि हुई", "ब्लॉकचेनवर पुष्टी झाली"),
    body: t(
      "The fingerprint is recorded on the blockchain and has been checked against the transaction. A file that produces the same fingerprint is unchanged since it was registered. This does not prove what the file shows is true, or how it was collected.",
      "फ़िंगरप्रिंट ब्लॉकचेन पर दर्ज है और लेन-देन से जाँचा गया है। जो फ़ाइल वही फ़िंगरप्रिंट देती है, वह पंजीकरण के बाद से नहीं बदली है। इससे यह सिद्ध नहीं होता कि फ़ाइल में दिखाई गई बात सच है या उसे कैसे एकत्र किया गया।",
      "फिंगरप्रिंट ब्लॉकचेनवर नोंदवलेला आहे आणि व्यवहाराशी तपासलेला आहे. जी फाइल तोच फिंगरप्रिंट देते ती नोंदणीनंतर बदललेली नाही. फाइलमध्ये दिसणारी गोष्ट खरी आहे किंवा ती कशी गोळा केली हे यावरून सिद्ध होत नाही."
    ),
    next: null,
    tone: "ok",
  },
  INTEGRITY_MISMATCH: {
    title: t("Fingerprint does not match", "फ़िंगरप्रिंट मेल नहीं खाता", "फिंगरप्रिंट जुळत नाही"),
    body: t(
      "A copy of this item was checked and produced a different fingerprint from the one recorded. The copy may have been changed, damaged, or may be a different file. This has been recorded and sent for review. It is not, by itself, a finding against anyone.",
      "इस वस्तु की एक प्रति जाँची गई और उसका फ़िंगरप्रिंट दर्ज फ़िंगरप्रिंट से अलग निकला। हो सकता है प्रति बदली गई हो, क्षतिग्रस्त हो, या कोई दूसरी फ़ाइल हो। इसे दर्ज कर समीक्षा के लिए भेजा गया है। यह अपने-आप में किसी के विरुद्ध निष्कर्ष नहीं है।",
      "या वस्तूची एक प्रत तपासली आणि तिचा फिंगरप्रिंट नोंदवलेल्या फिंगरप्रिंटपेक्षा वेगळा आला. प्रत बदललेली, खराब झालेली किंवा वेगळी फाइल असू शकते. हे नोंदवून पुनरावलोकनासाठी पाठवले आहे. हे स्वतःहून कोणाविरुद्धचा निष्कर्ष नाही."
    ),
    next: t(
      "The custodian and the court are notified. Keep the copy you checked unchanged.",
      "संरक्षक और न्यायालय को सूचित किया गया है। जिस प्रति की जाँच की, उसे बिना बदले रखें।",
      "संरक्षक आणि न्यायालयाला कळवले आहे. तपासलेली प्रत न बदलता ठेवा."
    ),
    tone: "problem",
  },
  SYNC_ERROR: {
    title: t("Could not be sent", "भेजा नहीं जा सका", "पाठवता आले नाही"),
    body: t(
      "Sending the fingerprint failed — for example the network was down or the transaction was rejected. The item itself is safe where it was recorded. It is not verified until it is sent successfully.",
      "फ़िंगरप्रिंट भेजना विफल रहा — जैसे नेटवर्क बंद था या लेन-देन अस्वीकार हुआ। वस्तु जहाँ दर्ज हुई वहाँ सुरक्षित है। सफलतापूर्वक भेजे जाने तक यह सत्यापित नहीं है।",
      "फिंगरप्रिंट पाठवणे अयशस्वी झाले — उदा. नेटवर्क बंद होते किंवा व्यवहार नाकारला गेला. वस्तू जिथे नोंदवली तिथे सुरक्षित आहे. यशस्वीपणे पाठवेपर्यंत ती सत्यापित नाही."
    ),
    next: t("Use Retry, or ask the court registry for help.", "दोबारा प्रयास करें, या न्यायालय रजिस्ट्री से सहायता लें।", "पुन्हा प्रयत्न करा, किंवा न्यायालय नोंदणी कार्यालयाची मदत घ्या."),
    tone: "attention",
  },
  REVIEW_REQUIRED: {
    title: t("Needs a person to review", "समीक्षा आवश्यक", "पुनरावलोकन आवश्यक"),
    body: t(
      "Something about this record could not be confirmed automatically — for example it waited too long, or the blockchain record changed. A person must look at it before it is treated as confirmed.",
      "इस रिकॉर्ड की कोई बात अपने-आप पुष्ट नहीं हो सकी — जैसे बहुत देर तक प्रतीक्षा रही, या ब्लॉकचेन रिकॉर्ड बदल गया। पुष्ट मानने से पहले किसी व्यक्ति को इसे देखना होगा।",
      "या नोंदीतील काही गोष्ट आपोआप पुष्टी होऊ शकली नाही — उदा. खूप वेळ थांबावे लागले, किंवा ब्लॉकचेन नोंद बदलली. पुष्टीकृत मानण्यापूर्वी एखाद्या व्यक्तीने ती पाहणे आवश्यक आहे."
    ),
    next: t("The court registry has been alerted.", "न्यायालय रजिस्ट्री को सूचित किया गया है।", "न्यायालय नोंदणी कार्यालयाला कळवले आहे."),
    tone: "attention",
  },
};

export function explainEvidence(state: VerificationState, lang: Lang): Explanation {
  const rule = EVIDENCE[state] ?? EVIDENCE.REVIEW_REQUIRED;
  return {
    title: pick(lang, rule.title),
    body: pick(lang, rule.body),
    next: rule.next ? pick(lang, rule.next) : null,
    tone: rule.tone,
  };
}

/* --------------------------------------------------------------- summons */

export type SummonsState = "PENDING" | "DELIVERED" | "FAILED";

export function explainSummons(
  input: { status: SummonsState; hoursRemaining?: number | null; hearingAt?: string | null },
  lang: Lang
): Explanation {
  if (input.status === "DELIVERED") {
    return {
      title: pick(lang, t("Summons acknowledged", "समन की पावती दी गई", "समन्सची पोच दिली")),
      body: pick(
        lang,
        t(
          "You have confirmed that you received this summons. The court can see that it reached you.",
          "आपने पुष्टि की है कि आपको यह समन मिला। न्यायालय देख सकता है कि यह आप तक पहुँचा।",
          "हे समन्स मिळाल्याची तुम्ही पुष्टी केली आहे. ते तुमच्यापर्यंत पोहोचले हे न्यायालय पाहू शकते."
        )
      ),
      next: input.hearingAt
        ? fill(pick(lang, t("Attend the hearing on {date}.", "{date} को सुनवाई में उपस्थित हों।", "{date} रोजी सुनावणीला उपस्थित राहा.")), {
            date: input.hearingAt,
          })
        : null,
      tone: "ok",
    };
  }
  if (input.status === "FAILED") {
    return {
      title: pick(lang, t("Not acknowledged in time", "समय पर पावती नहीं दी गई", "वेळेत पोच दिली नाही")),
      body: pick(
        lang,
        t(
          "The time allowed to acknowledge this summons has passed. The court has been told it was not acknowledged. This records that the acknowledgement did not happen — it does not say why.",
          "इस समन की पावती देने का समय बीत गया है। न्यायालय को बताया गया है कि पावती नहीं दी गई। यह केवल दर्ज करता है कि पावती नहीं हुई — कारण नहीं बताता।",
          "या समन्सची पोच देण्याची वेळ संपली आहे. पोच दिली नाही हे न्यायालयाला कळवले आहे. पोच झाली नाही एवढेच यात नोंदवले जाते — कारण नाही."
        )
      ),
      next: pick(
        lang,
        t(
          "Contact the court registry as soon as you can. You can ask for free legal aid.",
          "जितनी जल्दी हो सके न्यायालय रजिस्ट्री से संपर्क करें। आप निःशुल्क विधिक सहायता माँग सकते हैं।",
          "शक्य तितक्या लवकर न्यायालय नोंदणी कार्यालयाशी संपर्क करा. तुम्ही मोफत विधी सहाय्य मागू शकता."
        )
      ),
      tone: "problem",
    };
  }
  const hours = Math.max(0, Math.floor(input.hoursRemaining ?? 0));
  return {
    title: pick(lang, t("Summons waiting for you", "आपके लिए समन प्रतीक्षा में", "तुमच्यासाठी समन्स प्रतीक्षेत")),
    body: fill(
      pick(
        lang,
        t(
          "A court has issued a summons to you. You have about {hours} hours left to confirm that you received it.",
          "एक न्यायालय ने आपको समन जारी किया है। आपके पास इसकी प्राप्ति की पुष्टि के लिए लगभग {hours} घंटे बचे हैं।",
          "एका न्यायालयाने तुम्हाला समन्स जारी केले आहे. ते मिळाल्याची पुष्टी करण्यासाठी तुमच्याकडे सुमारे {hours} तास उरले आहेत."
        )
      ),
      { hours }
    ),
    next: pick(
      lang,
      t(
        "Open the summons and acknowledge it with the one-time code.",
        "समन खोलें और एक-बार वाले कोड से पावती दें।",
        "समन्स उघडा आणि एक-वेळ कोडने पोच द्या."
      )
    ),
    tone: hours <= 12 ? "attention" : "pending",
  };
}

/* --------------------------------------------------------------- check-in */

export type CheckInState = "DUE" | "OVERDUE" | "DONE_INSIDE" | "DONE_OUTSIDE" | "MISSED_WITH_REASON";

export function explainCheckIn(input: { state: CheckInState; hoursUntilDue?: number | null }, lang: Lang): Explanation {
  switch (input.state) {
    case "DONE_INSIDE":
      return {
        title: pick(lang, t("Check-in recorded", "हाज़िरी दर्ज हुई", "हजेरी नोंदवली")),
        body: pick(
          lang,
          t(
            "Your latest check-in was recorded inside the permitted area.",
            "आपकी पिछली हाज़िरी अनुमत क्षेत्र के भीतर दर्ज हुई।",
            "तुमची मागील हजेरी परवानगी असलेल्या क्षेत्रात नोंदवली गेली."
          )
        ),
        next: null,
        tone: "ok",
      };
    case "DONE_OUTSIDE":
      return {
        title: pick(lang, t("Check-in was outside the area", "हाज़िरी क्षेत्र के बाहर से", "हजेरी क्षेत्राबाहेरून")),
        body: pick(
          lang,
          t(
            "Your latest check-in was recorded outside the permitted area. If your location reading was inaccurate, the court is shown how accurate it was.",
            "आपकी पिछली हाज़िरी अनुमत क्षेत्र के बाहर दर्ज हुई। यदि आपकी स्थिति की रीडिंग सटीक नहीं थी, तो न्यायालय को उसकी सटीकता दिखाई जाती है।",
            "तुमची मागील हजेरी परवानगी असलेल्या क्षेत्राबाहेर नोंदवली गेली. तुमच्या स्थानाचे वाचन अचूक नसेल तर त्याची अचूकता न्यायालयाला दाखवली जाते."
          )
        ),
        next: pick(
          lang,
          t("You can add a reason for the court to see.", "आप न्यायालय के लिए कारण जोड़ सकते हैं।", "तुम्ही न्यायालयासाठी कारण जोडू शकता.")
        ),
        tone: "attention",
      };
    case "OVERDUE":
      return {
        title: pick(lang, t("Check-in overdue", "हाज़िरी बाकी है", "हजेरी थकली आहे")),
        body: pick(
          lang,
          t(
            "The time for your check-in has passed. A missed check-in is shown to the court together with any reason you give. It is not treated as a violation automatically.",
            "आपकी हाज़िरी का समय बीत गया है। छूटी हाज़िरी आपके दिए किसी भी कारण के साथ न्यायालय को दिखाई जाती है। इसे अपने-आप उल्लंघन नहीं माना जाता।",
            "तुमच्या हजेरीची वेळ संपली आहे. चुकलेली हजेरी तुम्ही दिलेल्या कारणासह न्यायालयाला दाखवली जाते. ती आपोआप उल्लंघन मानली जात नाही."
          )
        ),
        next: pick(
          lang,
          t(
            "Check in now if you can, and add the reason you could not check in on time.",
            "हो सके तो अभी हाज़िरी दें, और समय पर हाज़िरी न दे पाने का कारण जोड़ें।",
            "शक्य असल्यास आता हजेरी द्या, आणि वेळेवर हजेरी देऊ न शकल्याचे कारण जोडा."
          )
        ),
        tone: "problem",
      };
    case "MISSED_WITH_REASON":
      return {
        title: pick(lang, t("Reason given to the court", "कारण न्यायालय को दिया गया", "कारण न्यायालयाला दिले")),
        body: pick(
          lang,
          t(
            "You explained why you could not check in. The court sees your reason next to the missed check-in.",
            "आपने बताया कि आप हाज़िरी क्यों नहीं दे सके। न्यायालय छूटी हाज़िरी के साथ आपका कारण देखता है।",
            "तुम्ही हजेरी का देऊ शकला नाहीत ते सांगितले. चुकलेल्या हजेरीसोबत न्यायालय तुमचे कारण पाहते."
          )
        ),
        next: null,
        tone: "pending",
      };
    case "DUE":
    default: {
      const hours = Math.max(0, Math.floor(input.hoursUntilDue ?? 0));
      return {
        title: pick(lang, t("Next check-in", "अगली हाज़िरी", "पुढील हजेरी")),
        body: fill(
          pick(
            lang,
            t(
              "Your next check-in is due in about {hours} hours.",
              "आपकी अगली हाज़िरी लगभग {hours} घंटे में देय है।",
              "तुमची पुढील हजेरी सुमारे {hours} तासांत देय आहे."
            )
          ),
          { hours }
        ),
        next: pick(
          lang,
          t(
            "Check in from inside the permitted area, with location turned on.",
            "स्थान (लोकेशन) चालू रखकर अनुमत क्षेत्र के भीतर से हाज़िरी दें।",
            "स्थान (लोकेशन) चालू ठेवून परवानगी असलेल्या क्षेत्रातून हजेरी द्या."
          )
        ),
        tone: hours <= 6 ? "attention" : "pending",
      };
    }
  }
}

/* -------------------------------------------------------------- assistance */

export function explainAssistance(lang: Lang): Explanation {
  return {
    title: pick(lang, t("How to get help", "सहायता कैसे लें", "मदत कशी मिळवावी")),
    body: pick(
      lang,
      t(
        "If you cannot afford a lawyer you may be entitled to free legal aid from the District Legal Services Authority at your district court. For problems with this app — a code that does not arrive, a location that will not load — contact the court registry.",
        "यदि आप वकील का खर्च नहीं उठा सकते तो आप अपने जिला न्यायालय के जिला विधिक सेवा प्राधिकरण से निःशुल्क विधिक सहायता के पात्र हो सकते हैं। इस ऐप की समस्याओं के लिए — कोड न आना, स्थान लोड न होना — न्यायालय रजिस्ट्री से संपर्क करें।",
        "तुम्हाला वकिलाचा खर्च परवडत नसेल तर तुमच्या जिल्हा न्यायालयातील जिल्हा विधी सेवा प्राधिकरणाकडून मोफत विधी सहाय्य मिळण्यास तुम्ही पात्र असू शकता. या अॅपमधील अडचणींसाठी — कोड न येणे, स्थान लोड न होणे — न्यायालय नोंदणी कार्यालयाशी संपर्क करा."
      )
    ),
    next: pick(
      lang,
      t(
        "This screen cannot give advice about your case.",
        "यह स्क्रीन आपके मामले पर सलाह नहीं दे सकती।",
        "ही स्क्रीन तुमच्या प्रकरणाबद्दल सल्ला देऊ शकत नाही."
      )
    ),
    tone: "pending",
  };
}
