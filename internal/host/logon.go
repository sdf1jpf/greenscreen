package host

import (
	"errors"
	"strings"

	"github.com/sdf1jpf/greenscreen/internal/api"
	t3 "github.com/sdf1jpf/greenscreen/tn3270"
)

// defaultBanner is shown when the application sends none.
var defaultBanner = []string{
	` ######  ######  #####   ##   ##  ######  ##   ##    ###    ##     `,
	`   ##    ##      ##  ##  ### ###    ##    ###  ##   ## ##   ##     `,
	`   ##    #####   #####   ## # ##    ##    ## # ##  ##   ##  ##     `,
	`   ##    ##      ##  ##  ##   ##    ##    ##  ###  #######  ##     `,
	`   ##    ######  ##   ## ##   ##  ######  ##   ##  ##   ##  ###### `,
}

// logon is the VTAM-style welcome and sign-on screen. Who may log on is
// decided by Cloudflare Access, so there is no userid or password to type:
// Enter signs in through the browser and the API names the userid.
type logon struct {
	msg string
}

func (l *logon) Render(s *Session) *t3.Screen {
	scr := t3.NewScreenSize(s.rows, s.cols)
	// The welcome panel is centered in whatever room the window gives it.
	dy, dx := (scr.Rows()-t3.MinRows)/2, (scr.Cols()-t3.MinCols)/2
	banner := s.cfg.Banner
	if len(banner) == 0 {
		banner = defaultBanner
	}
	for i, line := range banner[:min(len(banner), 5)] {
		scr.Text(dy+3+i, (scr.Cols()-len(line))/2+1, line, t3.WithColor(t3.Blue), t3.Bright)
	}
	tag := spaced(s.cfg.Title)
	if tag == "" || len(tag) > scr.Cols()-2 {
		tag = s.cfg.Title
	}
	if tag != "" {
		scr.Text(dy+9, (scr.Cols()-len(tag))/2+1, tag, t3.WithColor(t3.Turquoise))
	}

	scr.Text(dy+11, dx+12, "SYSTEM . . . . : "+s.cfg.SystemName, t3.WithColor(t3.Blue))
	scr.Text(dy+12, dx+12, "TERMINAL . . . : "+s.lu, t3.WithColor(t3.Blue))
	scr.Text(dy+13, dx+12, "HOST . . . . . : "+strings.ToUpper(s.api().Host()), t3.WithColor(t3.Blue))

	scr.Text(dy+15, dx+12, "PRESS ENTER TO LOG ON.", t3.WithColor(t3.Turquoise))
	scr.Text(dy+16, dx+12, "Sign-on is through Cloudflare Access; a browser window", t3.WithColor(t3.Yellow))
	scr.Text(dy+17, dx+12, "opens if you are not already signed in.", t3.WithColor(t3.Yellow))
	scr.Text(dy+20, dx+12, "UNAUTHORIZED ACCESS TO THIS SYSTEM IS PROHIBITED.", t3.WithColor(t3.Red))

	message(scr, l.msg)
	scr.Text(scr.Rows(), 2, "ENTER=LOGON  PF3=DISCONNECT", t3.WithColor(t3.Turquoise))
	scr.CursorHome()
	return scr
}

// submitLogon handles an AID on the logon screen. Enter signs in through
// Cloudflare Access, then asks the application for its first screen.
func (s *Session) submitLogon(aid t3.AID, scr *t3.Screen) *t3.Screen {
	l := s.logon
	switch aid {
	case t3.AIDEnter:
	case t3.PF(3):
		return nil
	case t3.AIDClear:
		s.logon = &logon{}
		return s.logon.Render(s)
	case t3.PF(1):
		l.msg = "IKJ56700I PRESS ENTER TO LOG ON - PF1 GIVES HELP ON EVERY SCREEN AFTER THAT"
		return l.Render(s)
	default:
		l.msg = s.msg("0000W") + " " + aid.String() + " IS NOT ACTIVE ON THIS SCREEN"
		return l.Render(s)
	}
	who, err := s.api().Logon(s.ctx())
	switch {
	case errors.Is(err, api.ErrBadLogon):
		l.msg = "IKJ56421I LOGON NOT AUTHORIZED BY CLOUDFLARE ACCESS"
		return l.Render(s)
	case err != nil:
		l.msg = s.fail(err)
		return l.Render(s)
	}
	s.user = who
	return s.start()
}

// spaced letterspaces a title, "POS" -> "P O S", with three spaces between
// words, for the logon screen.
func spaced(title string) string {
	words := strings.Fields(strings.ToUpper(title))
	for i, w := range words {
		words[i] = strings.Join(strings.Split(w, ""), " ")
	}
	return strings.Join(words, "   ")
}
